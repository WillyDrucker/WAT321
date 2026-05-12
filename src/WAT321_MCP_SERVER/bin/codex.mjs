/**
 * Codex target handlers for the unified WAT321 bridge. Covers the
 * happy path (write envelope, await reply, return body), late-reply
 * collection, and fire-and-forget dispatch (per-call override or
 * sticky wait-mode toggle from the Epic Handshake status bar).
 *
 * Advanced modes that the pre-1.5.0 channel had but this bridge does
 * NOT (carry-forward backlog for future ports):
 *
 *   - adaptive heartbeat (ADAPTIVE_FLAG) - extends timeout while the
 *     dispatcher's per-turn heartbeat stays fresh
 *   - stale-heartbeat auto-abort (7-min watchdog with synthetic abort
 *     envelope deposit)
 *   - clipboard attachment sweeping
 *   - queue summary tail line
 *   - schema-fix hint when caller passes 'prompt' instead of 'text'
 *
 * Track regressions against
 * https://github.com/WillyDrucker/WAT321/issues.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const EH_DIR = join(homedir(), ".wat321", "epic-handshake");
const INBOX_CLAUDE_ROOT = join(EH_DIR, "inbox", "claude");
const INBOX_CODEX_ROOT = join(EH_DIR, "inbox", "codex");
const SENT_CLAUDE_ROOT = join(EH_DIR, "sent", "claude");
const PAUSED_FLAG = join(EH_DIR, "paused.flag");
const FIRE_AND_FORGET_FLAG = join(EH_DIR, "fire-and-forget.flag");
// Sidecar consumed by `WAT321_EPIC_HANDSHAKE/waitStatus.ts` so the
// Claude session-token tooltip can render "Waiting on Codex: Ns"
// while a synchronous reply wait is in flight. Per-workspace
// filename so sibling VS Code windows don't see each other's waits.

const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_SEC = 120;
const MIN_TIMEOUT_MS = 5_000;

const WORKSPACE_PATH = process.env.WAT321_WORKSPACE_PATH || process.cwd();
const WORKSPACE_HASH = createHash("sha256")
  .update(
    WORKSPACE_PATH.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase(),
    "utf8"
  )
  .digest("hex")
  .slice(0, 16);

const INBOX_CLAUDE = join(INBOX_CLAUDE_ROOT, WORKSPACE_HASH);
const INBOX_CODEX = join(INBOX_CODEX_ROOT, WORKSPACE_HASH);
const SENT_CLAUDE = join(SENT_CLAUDE_ROOT, WORKSPACE_HASH);

/** Per-process fingerprint stamped onto outbound envelopes so the
 * dispatcher can identify which server originated a request. Inbound
 * filtering happens at the workspace-hash directory level (each server
 * only reads its own `INBOX_CLAUDE` partition), so envelopes from a
 * sibling VS Code window never reach this server's scan. The
 * fingerprint stays on the outbound side for diagnostics + dispatcher
 * hints; inbound routing intentionally does NOT match against it,
 * since process restarts (vsix swap, MCP reload) rotate the fingerprint
 * and any in-flight reply produced under the old value would otherwise
 * be silently ignored. Inbound match relies on workspace partition +
 * `reply_to` / `chain_id`. */
const SESSION_FP = randomUUID();

function ensureDirs() {
  for (const dir of [INBOX_CLAUDE, INBOX_CODEX, SENT_CLAUDE]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeYaml(v) {
  if (/[:#\n]/.test(v)) return JSON.stringify(v);
  return v;
}

function buildEnvelope(fields) {
  const now = new Date().toISOString();
  const lines = ["---"];
  lines.push(`id: ${fields.id}`);
  lines.push(`chain_id: ${fields.chainId}`);
  lines.push(`iteration: ${fields.iteration}`);
  lines.push(`source: ${fields.source}`);
  lines.push(`target: ${fields.target}`);
  lines.push(`source_session_fp: ${fields.sourceSessionFp}`);
  lines.push(`priority: ${fields.priority}`);
  lines.push(`intent: ${fields.intent}`);
  lines.push(`workspace_path: ${fields.workspacePath}`);
  lines.push(`created_at: ${now}`);
  lines.push(`reply_to: ${fields.replyTo === null ? "null" : fields.replyTo}`);
  if (fields.title) lines.push(`title: ${escapeYaml(fields.title)}`);
  lines.push("---");
  lines.push("");
  lines.push(fields.body || "");
  lines.push("");
  return lines.join("\n");
}

function parseEnvelope(raw) {
  if (!raw.startsWith("---")) return null;
  const sep = raw.indexOf("\n---", 3);
  if (sep === -1) return null;
  const frontmatter = raw.slice(3, sep).trim();
  const body = raw.slice(sep + 4).replace(/^\s*\n/, "").trimEnd();
  const fields = {};
  for (const line of frontmatter.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val === "null") val = null;
    else if (val.startsWith('"')) {
      try {
        val = JSON.parse(val);
      } catch {
        // keep raw
      }
    }
    fields[key] = val;
  }
  return { fields, body };
}

function writeAtomic(path, content) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/** Walk inbox/claude for envelopes addressed to this session that
 * predate the 5-second active-poll cutoff. Returns the matched
 * envelopes WITHOUT moving the source files. Drain variants are
 * built on top of this primitive when consumption is intended. */
function scanLateReplies() {
  const out = [];
  const cutoff = Date.now() - 5_000;
  let files;
  try {
    files = readdirSync(INBOX_CLAUDE);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const p = join(INBOX_CLAUDE, f);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.mtimeMs >= cutoff) continue;
    let raw;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const parsed = parseEnvelope(raw);
    if (!parsed) continue;
    // Workspace partitioning at the directory level already filters
    // sibling VS Code windows; do not gate on `source_session_fp`
    // since process restarts rotate the fingerprint and would orphan
    // any reply produced under the prior value.
    out.push({
      filename: f,
      sourcePath: p,
      body: parsed.body,
      createdAt: parsed.fields.created_at,
    });
  }
  return out;
}

/** Format the late-reply preamble for an active dispatch without
 * consuming the source files. Returns the formatted text plus the
 * envelopes scanned, so the caller can move them to `sent/` only after
 * the outbound envelope is durably on disk. Splitting scan from
 * consume avoids losing late replies when the outbound write throws -
 * if we moved-then-wrote, a write failure would leave the user's late
 * replies stranded in `sent/` with no delivery. */
function peekLateRepliesForPreamble() {
  const found = scanLateReplies();
  if (found.length === 0) return { preamble: "", found };
  const chunks = found.map(
    (r, i) =>
      `[Late reply ${i + 1}/${found.length} from Codex, originally sent ${r.createdAt || "earlier"}]\n${r.body}`
  );
  return { preamble: chunks.join("\n\n---\n\n"), found };
}

/** Move the late-reply source files to `sent/` after the outbound
 * envelope is written. Best-effort: a rename failure does not roll
 * back the dispatch. */
function consumeLateReplyFiles(found) {
  for (const r of found) {
    try {
      renameSync(r.sourcePath, join(SENT_CLAUDE, r.filename));
    } catch {
      // best-effort
    }
  }
}

/** Find a reply envelope matching a given dispatched prompt id. */
function findReplyEnvelope(promptId) {
  let files;
  try {
    files = readdirSync(INBOX_CLAUDE);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const p = join(INBOX_CLAUDE, f);
    let raw;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const parsed = parseEnvelope(raw);
    if (!parsed) continue;
    // Match on `reply_to` / `chain_id` only. Workspace directory
    // already filters siblings; the per-process fingerprint would
    // orphan replies across an MCP-server restart.
    if (
      parsed.fields.reply_to !== promptId &&
      parsed.fields.chain_id !== promptId
    ) {
      continue;
    }
    return { filename: f, body: parsed.body, fields: parsed.fields };
  }
  return null;
}

/** Fire-and-forget safety cap. The happy path returns sub-100ms
 * (envelope write + immediate return); this race exists as a
 * defensive belt against any future regression that lets the FF
 * branch fall through to a wait. Adaptive/standard dispatches are
 * intentionally not capped here; long waits there are expected and
 * bounded by `timeout_sec`.
 *
 * Limitation: `runDispatch`'s I/O is sync (`writeFileSync`,
 * `renameSync`, `existsSync`). A truly pathological FS hang would
 * block the whole event loop and prevent the timer from firing
 * anyway, so the race is structural insurance against future code
 * shape changes, not a defense against current sync-FS-blocking. */
const FF_SAFETY_CAP_MS = 60_000;

/** Handle a `wat321_ask({target: "codex", ...})` call. */
export async function handleAsk(args) {
  ensureDirs();

  const prompt = typeof args?.prompt === "string" ? args.prompt : "";
  if (prompt.trim().length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "Expected a non-empty `prompt` argument for target=codex.",
        },
      ],
      isError: true,
    };
  }

  if (existsSync(PAUSED_FLAG)) {
    return {
      content: [
        {
          type: "text",
          text: "Epic Handshake is paused. Resume from the status bar widget to dispatch new prompts.",
        },
      ],
    };
  }

  // Detect fire-and-forget intent before any I/O so the safety race
  // below covers every step (preamble scan, envelope write, late-
  // reply consume). Per-call `fire_and_forget: true` always wins;
  // per-call `fire_and_forget: false` always forces a synchronous
  // wait even if the user's wait-mode toggle is set. When the param
  // is omitted, the sticky flag file written by the Epic Handshake
  // status bar's wait-mode toggle (`waitMode.ts`) decides.
  const explicitFireAndForget =
    typeof args?.fire_and_forget === "boolean" ? args.fire_and_forget : null;
  const fireAndForget =
    explicitFireAndForget !== null
      ? explicitFireAndForget
      : existsSync(FIRE_AND_FORGET_FLAG);

  if (!fireAndForget) return runDispatch(args, prompt, false);

  // Clearable timer so the happy path (sub-100ms) does not leave a
  // dangling 60s setTimeout sitting in the Node event queue. The
  // inner runDispatch is sync-heavy and not cancellable; if the cap
  // ever wins, the dispatch keeps running to completion in the
  // background (envelope still lands, late-reply file still moves -
  // both idempotent against later state).
  let safetyTimer = null;
  const safetyCap = new Promise((resolve) => {
    safetyTimer = setTimeout(() => {
      safetyTimer = null;
      resolve({
        content: [
          {
            type: "text",
            text:
              `Fire-and-forget safety cap reached at ${Math.round(FF_SAFETY_CAP_MS / 1000)}s. ` +
              "The bridge held the dispatch longer than fire-and-forget's no-wait contract allows; this is unexpected. " +
              "Codex's reply, if any, will still land in the Epic Handshake inbox. " +
              "If this recurs, restart the bridge from the status bar widget.",
          },
        ],
      });
    }, FF_SAFETY_CAP_MS);
  });
  try {
    return await Promise.race([runDispatch(args, prompt, true), safetyCap]);
  } finally {
    if (safetyTimer !== null) clearTimeout(safetyTimer);
  }
}

async function runDispatch(args, prompt, fireAndForget) {
  const { preamble: latePreamble, found: latePending } =
    peekLateRepliesForPreamble();

  const id = randomUUID();
  const timeoutSec =
    typeof args?.timeout_sec === "number" && Number.isFinite(args.timeout_sec)
      ? args.timeout_sec
      : DEFAULT_TIMEOUT_SEC;
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, timeoutSec * 1000);

  const envelope = buildEnvelope({
    id,
    chainId: id,
    iteration: 0,
    source: "claude",
    target: "codex",
    sourceSessionFp: SESSION_FP,
    priority: "normal",
    intent: "question",
    title: "",
    workspacePath: WORKSPACE_PATH,
    replyTo: null,
    body: prompt,
  });

  writeAtomic(join(INBOX_CODEX, `${id}.md`), envelope);
  // Outbound envelope is now durably on disk; safe to move the late
  // replies into `sent/`. If the writeAtomic above had thrown, the
  // late replies would still be in the inbox for the next dispatch.
  consumeLateReplyFiles(latePending);

  // Fire-and-forget short-circuit. Wording is load-bearing - the
  // legacy `epic_handshake/bin/channel.mjs` path used the same
  // phrasing and at least one operator playbook grew up around
  // recognizing it as "intentional, not a timeout."
  if (fireAndForget) {
    const ffMessage =
      `Fire-and-forget dispatch complete. The prompt was delivered to Codex and this tool returned immediately as intended - no wait was attempted and this is not a timeout. Dispatch id: ${id}. ` +
      "Codex will reply on its own schedule; the reply will appear in the Epic Handshake inbox (retrieve via the status bar widget, or it will auto-include on your next Claude-to-Codex prompt).";
    return {
      content: [
        {
          type: "text",
          text: latePreamble ? `${latePreamble}\n\n---\n\n${ffMessage}` : ffMessage,
        },
      ],
    };
  }

  // Wait-status sidecar drives the "Waiting on Codex: Ns" tooltip
  // line on the Claude session-tokens widget. Written before the
  // poll loop, cleared on every exit (reply, timeout, throw) via
  // the try/finally below so the tooltip never sticks on a stale
  // wait. Best-effort - failing to write/clear must never break
  // the dispatch.
  const waitStatusPath = join(EH_DIR, `wait-status.${WORKSPACE_HASH}.json`);
  writeWaitStatus(waitStatusPath, id, timeoutSec);
  try {
    const deadline = Date.now() + timeoutMs;
    let replyMatch = null;
    while (Date.now() < deadline) {
      replyMatch = findReplyEnvelope(id);
      if (replyMatch !== null) break;
      await sleep(POLL_INTERVAL_MS);
    }

    if (replyMatch === null) {
      // Final-tick rescue before returning timeout.
      replyMatch = findReplyEnvelope(id);
    }

    if (replyMatch !== null) {
      try {
        renameSync(
          join(INBOX_CLAUDE, replyMatch.filename),
          join(SENT_CLAUDE, replyMatch.filename)
        );
      } catch {
        // best-effort
      }
      const text = latePreamble
        ? `${latePreamble}\n\n---\n\n${replyMatch.body}`
        : replyMatch.body;
      return { content: [{ type: "text", text }] };
    }

    const timeoutMsg = `No reply from Codex within ${Math.round(timeoutMs / 1000)}s. The dispatcher may still be running; the reply will land in the Epic Handshake inbox if it completes. Retry with timeout_sec for longer-running analyses.`;
    return {
      content: [
        {
          type: "text",
          text: latePreamble ? `${latePreamble}\n\n---\n\n${timeoutMsg}` : timeoutMsg,
        },
      ],
    };
  } finally {
    clearWaitStatus(waitStatusPath);
  }
}

function writeWaitStatus(path, envelopeId, timeoutSec) {
  try {
    writeFileSync(
      path,
      JSON.stringify({
        envelopeId,
        workspaceHash: WORKSPACE_HASH,
        target: "codex",
        timeoutSec,
        startedAt: Date.now(),
      }),
      "utf8"
    );
  } catch {
    // best-effort
  }
}

function clearWaitStatus(path) {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}

/** MCP resource backing `bridge://inbox/codex`. Read-only (peek):
 * surfaces queued late replies WITHOUT moving them to sent/. The
 * active dispatch path peeks via `peekLateRepliesForPreamble` and
 * consumes via `consumeLateReplyFiles` only after the outbound
 * envelope is durably on disk; resources reading the inbox should
 * have no consumption side effect. */
export async function listInboxResource() {
  ensureDirs();
  const found = scanLateReplies();
  return {
    pending: found.map((r) => ({
      filename: r.filename,
      createdAt: r.createdAt,
      body: r.body,
    })),
    note:
      found.length > 0
        ? "Late replies are queued. They will be injected as a preamble on the next Codex dispatch automatically."
        : "Inbox is empty.",
  };
}
