import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomicWrite.mjs";
import { errorResult, textResult } from "./mcpResults.mjs";
import { bridgeStateDir, ensureDir } from "./wat321Paths.mjs";

/**
 * The fire-and-forget mailbox for non-Codex targets (opencode, local)
 * under `<bridgeStateDir>/{dispatch,inbox,sent}/<target>/`. This
 * runtime writes an outbound envelope to `dispatch/` and returns at
 * once. The extension-side OpenCodeDispatcher watches that dir, runs
 * the HTTP/SSE call, and writes the reply to `inbox/`, where
 * `wat321_bridge()` drains it into `sent/`.
 *
 * The dispatch runs in the extension host, not here, because the
 * Node process Claude Code spawned for the MCP transport is
 * independent from VS Code: an MCP-side exit would abort any in-
 * flight work running inside it, while the extension host scopes the
 * lifecycle to VS Code itself and its `BackendDispatcher.shutdown()`
 * contract lands a "cancelled by shutdown" envelope for anything still
 * running on deactivate. Codex follows the same shape. Sync dispatch
 * still runs inline in `opencode/dispatch.mjs`, since an envelope
 * round-trip buys nothing when the caller is blocking on the reply.
 */

const NON_CODEX_TARGETS = ["opencode", "local"];

function dispatchDir(target) {
  return join(bridgeStateDir(), "dispatch", target);
}

function inboxDir(target) {
  return join(bridgeStateDir(), "inbox", target);
}

function sentDir(target) {
  return join(bridgeStateDir(), "sent", target);
}

function escapeYaml(v) {
  if (/[:#\n]/.test(v)) return JSON.stringify(v);
  return v;
}

/** Outbound envelope text. YAML keys here MUST stay in sync with the
 * parser at `src/engine/inbox/envelope.ts`: the extension-host engine
 * parses every envelope this runtime writes, so renaming a key on
 * either side without the other silently strands envelopes in the
 * inbox with no error. `sessionAlias` is the caller's explicit
 * `session` arg, which the dispatcher reads to pin the dispatch to a
 * user-created S<n> session instead of the active alias on disk. */
function serializeOutbound({ id, target, alias, prompt, waitMode, workspacePath, sessionAlias }) {
  const createdAt = new Date().toISOString();
  const preview =
    prompt.length > 200
      ? `${prompt.slice(0, 200).replace(/\n/g, " ")}...`
      : prompt.replace(/\n/g, " ");
  const lines = ["---"];
  lines.push(`id: ${id}`);
  lines.push("kind: outbound");
  lines.push(`target: ${target}`);
  lines.push(`created_at: ${createdAt}`);
  if (workspacePath) lines.push(`workspace_path: ${escapeYaml(workspacePath)}`);
  if (alias) lines.push(`alias: ${escapeYaml(alias)}`);
  if (waitMode) lines.push(`wait_mode: ${waitMode}`);
  if (sessionAlias) lines.push(`session_alias: ${sessionAlias}`);
  lines.push(`prompt_preview: ${escapeYaml(preview)}`);
  lines.push("---", "", prompt, "");
  return lines.join("\n");
}

/** Queue an outbound envelope for the extension-side dispatcher and
 * return the FF confirmation immediately. */
export function dispatchFireAndForget(target, args) {
  if (!NON_CODEX_TARGETS.includes(target)) {
    throw new Error(`fire-and-forget expects a non-Codex target, got '${target}'`);
  }
  const id = randomUUID();
  const prompt = typeof args?.prompt === "string" ? args.prompt : "";
  const alias =
    typeof args?.alias === "string" && args.alias.length > 0 ? args.alias : target;
  const sessionAlias =
    typeof args?.session === "string" && args.session.length > 0
      ? args.session
      : null;
  const waitMode = "fire-and-forget";

  try {
    writeFileAtomic(
      join(dispatchDir(target), `${id}.md`),
      serializeOutbound({ id, target, alias, prompt, waitMode, sessionAlias })
    );
  } catch (err) {
    return errorResult(
      `Fire-and-forget dispatch could not be queued: ${err?.message || String(err)}. The bridge inbox directory may be unwritable. No reply will land; reissue when the filesystem is healthy.`
    );
  }

  const promptPreview =
    prompt.length > 80
      ? `${prompt.slice(0, 80).replace(/\n/g, " ")}...`
      : prompt.replace(/\n/g, " ");
  return textResult(
    `Fire-and-forget dispatch to ${alias} (target=${target}) accepted. Dispatch id: ${id}. ` +
      `The MCP tool returned immediately as intended - no wait attempted, no timeout. The extension-side dispatcher will run the call on its own schedule; the reply lands in the bridge inbox when complete and is retrievable with \`wat321_bridge()\`. If VS Code is closed before the dispatch completes, a synthetic "cancelled by shutdown" envelope will land in its place so the outcome is always visible.\n\n` +
      "What to do next:\n" +
      "1. Return control to the user right now. Do not say \"still working\", do not offer to poll, do not call this tool again for this prompt.\n" +
      "2. When the user asks for the reply, retrieve it with `wat321_bridge()`.\n" +
      "3. Never read inbox files directly with Read or cat - that desyncs the bridge and the next consume will double-inject.\n\n" +
      `Dispatch summary: prompt="${promptPreview}".`
  );
}

function listMarkdown(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

/** Drain pending FF replies for every non-Codex target, moving the
 * consumed files to `sent/`. A file whose move fails stays in the
 * inbox and the next drain picks it up again. */
export async function consumeNonCodexInbox(replyId) {
  const drained = [];
  for (const target of NON_CODEX_TARGETS) {
    const dir = inboxDir(target);
    for (const file of listMarkdown(dir)) {
      if (replyId && file !== `${replyId}.md` && !file.startsWith(`${replyId}.`)) {
        continue;
      }
      const inboxPath = join(dir, file);
      let content;
      try {
        content = readFileSync(inboxPath, "utf8");
      } catch {
        continue;
      }
      drained.push({ target, filename: file, content });
      try {
        ensureDir(sentDir(target));
        renameSync(inboxPath, join(sentDir(target), file));
      } catch {
        // best-effort
      }
    }
  }
  return drained;
}

/** Outbound (in-flight) FF dispatches per non-Codex target, oldest
 * first so the agent reports the longest-running dispatch first. Each
 * entry carries the dispatch id, target, age, and the prompt preview
 * from the envelope frontmatter when readable. Unreadable files are
 * skipped, the drain surfaces them whenever they resolve. */
export function inFlightNonCodexSummary() {
  const inFlight = [];
  for (const target of NON_CODEX_TARGETS) {
    const dir = dispatchDir(target);
    for (const file of listMarkdown(dir)) {
      const path = join(dir, file);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      let alias = null;
      let promptPreview = null;
      try {
        const fm = readFileSync(path, "utf8").match(/^---\n([\s\S]*?)\n---/);
        if (fm) {
          const aliasMatch = fm[1].match(/^alias:\s*(.+)$/m);
          if (aliasMatch) alias = aliasMatch[1].trim().replace(/^"(.*)"$/, "$1");
          const previewMatch = fm[1].match(/^prompt_preview:\s*(.+)$/m);
          if (previewMatch) {
            promptPreview = previewMatch[1].trim().replace(/^"(.*)"$/, "$1");
          }
        }
      } catch {
        // best-effort
      }
      inFlight.push({
        id: file.replace(/\.md$/, ""),
        target,
        alias,
        promptPreview,
        ageSec: Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000)),
      });
    }
  }
  inFlight.sort((a, b) => b.ageSec - a.ageSec);
  return inFlight;
}

/** Read-only peek for `bridge://inbox/{target}`. */
export function listNonCodexInboxResource(target) {
  if (!NON_CODEX_TARGETS.includes(target)) return { inbox: [] };
  const dir = inboxDir(target);
  return {
    inbox: listMarkdown(dir).map((f) => {
      let completedAt = null;
      try {
        completedAt = new Date(statSync(join(dir, f)).mtimeMs).toISOString();
      } catch {
        completedAt = null;
      }
      return { id: f.replace(/\.md$/, ""), target, completedAt };
    }),
  };
}
