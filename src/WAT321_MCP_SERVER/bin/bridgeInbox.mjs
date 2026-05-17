import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { bridgeStateDir } from "./paths.mjs";

/**
 * Fire-and-forget dispatch helper for non-Codex targets (opencode,
 * local). The MCP runtime calls `dispatchFireAndForget(target, args)`
 * which writes a single outbound envelope to
 * `<bridgeStateDir>/dispatch/<target>/<id>.md` and returns
 * immediately with a confirmation. The extension-side OpenCodeDispatcher
 * watches that dir, picks up the envelope, runs the HTTP/SSE call,
 * and writes the inbound reply to `<bridgeStateDir>/inbox/<target>/`
 * where `wat321_bridge()` drains it.
 *
 * Why the dispatch lives in the extension host instead of inside the
 * MCP runtime process:
 *   - Survives MCP server restart. The Node process Claude Code
 *     spawned for the MCP transport is independent from the VS Code
 *     extension host. An MCP-side process exit would abort any
 *     in-flight FF work running inside it; running the dispatch from
 *     the extension host scopes the lifecycle to VS Code itself.
 *   - Graceful shutdown. The extension-side dispatcher implements the
 *     engine's `BackendDispatcher.shutdown()` contract; on VS Code
 *     deactivate, in-flight dispatches are cancelled and "cancelled
 *     by shutdown" inbound envelopes land so the user sees a clear
 *     outcome on next launch.
 *   - Symmetry with Codex. The Codex dispatcher runs in the extension
 *     host (it manages the `codex app-server` subprocess); opencode
 *     and local follow the same shape.
 *
 * Sync dispatch continues to run inline in the MCP runtime via
 * `opencode/dispatch.mjs:handleAsk` - there is no benefit to envelope
 * round-trip when the caller is blocking on the reply, and the
 * direct HTTP path keeps that latency floor low.
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

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/** Atomic write via tmp+rename so the OutboundWatcher's fs-watch
 * never sees a partial file. */
function writeAtomic(path, content) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function esc(v) {
  if (/[:#\n]/.test(v)) return JSON.stringify(v);
  return v;
}

/** Build the outbound envelope text. Matches the unified schema in
 * `src/engine/inbox/envelope.ts` (kind=outbound, target, alias, etc.)
 * so the engine-side reader parses cleanly. `sessionAlias` is the
 * caller's explicit `session` arg from wat321_ask; the extension-side
 * dispatcher reads it to pin the dispatch to a user-created S<n>
 * session instead of falling back to whatever the active alias is on
 * disk. Without this propagation an explicit session arg gets dropped
 * on the FF path. */
// YAML keys here MUST stay in sync with the parser at
// `engine/inbox/envelope.ts`. The extension-host engine parses every
// envelope this MJS writes; renaming a key on either side without the
// other silently strands envelopes in the inbox with no error.
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
  if (workspacePath) lines.push(`workspace_path: ${esc(workspacePath)}`);
  if (alias) lines.push(`alias: ${esc(alias)}`);
  if (waitMode) lines.push(`wait_mode: ${waitMode}`);
  if (sessionAlias) lines.push(`session_alias: ${sessionAlias}`);
  lines.push(`prompt_preview: ${esc(preview)}`);
  lines.push("---", "", prompt, "");
  return lines.join("\n");
}

/** Write an outbound envelope for the extension-side dispatcher to
 * pick up, and return the FF confirmation tool response immediately. */
export function dispatchFireAndForget(target, args) {
  if (!NON_CODEX_TARGETS.includes(target)) {
    throw new Error(`bridgeInbox FF expects a non-Codex target, got '${target}'`);
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

  const dir = dispatchDir(target);
  ensureDir(dir);
  try {
    writeAtomic(
      join(dir, `${id}.md`),
      serializeOutbound({ id, target, alias, prompt, waitMode, sessionAlias })
    );
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text:
            `Fire-and-forget dispatch could not be queued: ${
              err?.message || String(err)
            }. The bridge inbox directory may be unwritable. No reply will land; reissue when the filesystem is healthy.`,
        },
      ],
      isError: true,
    };
  }

  const promptPreview =
    prompt.length > 80
      ? `${prompt.slice(0, 80).replace(/\n/g, " ")}...`
      : prompt.replace(/\n/g, " ");
  const text =
    `Fire-and-forget dispatch to ${alias} (target=${target}) accepted. Dispatch id: ${id}. ` +
    `The MCP tool returned immediately as intended - no wait attempted, no timeout. The extension-side dispatcher will run the call on its own schedule; the reply lands in the bridge inbox when complete and is retrievable with \`wat321_bridge()\`. If VS Code is closed before the dispatch completes, a synthetic "cancelled by shutdown" envelope will land in its place so the outcome is always visible.\n\n` +
    "What to do next:\n" +
    "1. Return control to the user right now. Do not say \"still working\", do not offer to poll, do not call this tool again for this prompt.\n" +
    "2. When the user asks for the reply, retrieve it with `wat321_bridge()`.\n" +
    "3. Never read inbox files directly with Read or cat - that desyncs the bridge and the next consume will double-inject.\n\n" +
    `Dispatch summary: prompt="${promptPreview}".`;

  return { content: [{ type: "text", text }] };
}

/** Drain pending FF replies for non-Codex targets. Unchanged contract
 * (channel.mjs's `dispatchBridgeDrain` calls this and joins with
 * Codex's drain). Atomically moves consumed files to sent/. */
export async function consumeNonCodexInbox(replyId) {
  const drained = [];
  for (const target of NON_CODEX_TARGETS) {
    const dir = inboxDir(target);
    if (!existsSync(dir)) continue;
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
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
        // best-effort - file stays in inbox; next consume re-drains
      }
    }
  }
  return drained;
}

/** Summarize outbound (in-flight) FF dispatches per non-Codex target.
 * Returned by `wat321_bridge()` in the empty-inbox path so the agent
 * can report "still working" honestly instead of hedging "the reply
 * may or may not still be in flight". Each entry carries the dispatch
 * id, target, age in seconds, and the prompt preview from the envelope
 * frontmatter when readable.
 *
 * Best-effort: unreadable files are skipped (the drain will surface
 * them whenever they resolve to an inbound). Sorting is oldest-first
 * so the agent reports the longest-running dispatch first - that's
 * the one most likely to need user attention. */
export function inFlightNonCodexSummary() {
  const inFlight = [];
  for (const target of NON_CODEX_TARGETS) {
    const dir = dispatchDir(target);
    if (!existsSync(dir)) continue;
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
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
        const raw = readFileSync(path, "utf8");
        const fm = raw.match(/^---\n([\s\S]*?)\n---/);
        if (fm) {
          const block = fm[1];
          const aliasMatch = block.match(/^alias:\s*(.+)$/m);
          if (aliasMatch) {
            alias = aliasMatch[1].trim().replace(/^"(.*)"$/, "$1");
          }
          const previewMatch = block.match(/^prompt_preview:\s*(.+)$/m);
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

/** Peek the non-Codex inbox for a specific target. Read-only,
 * mirrors `codex.listInboxResource` for the unified resource catalog
 * at `bridge://inbox/{target}`. */
export function listNonCodexInboxResource(target) {
  if (!NON_CODEX_TARGETS.includes(target)) {
    return { inbox: [] };
  }
  const dir = inboxDir(target);
  if (!existsSync(dir)) return { inbox: [] };
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return { inbox: [] };
  }
  return {
    inbox: files.map((f) => {
      const inboxPath = join(dir, f);
      let st = null;
      try {
        st = statSync(inboxPath);
      } catch {
        st = null;
      }
      return {
        id: f.replace(/\.md$/, ""),
        target,
        completedAt: st ? new Date(st.mtimeMs).toISOString() : null,
      };
    }),
  };
}

