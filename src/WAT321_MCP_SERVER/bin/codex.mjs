/**
 * Codex target handlers for the unified WAT321 bridge. Covers three
 * wait modes plus inbox consume:
 *
 *   - sync: poll for reply until `timeout_sec` (default 120s).
 *   - fire-and-forget: write envelope, return immediately. Reply lands
 *     in the per-workspace inbox for a later `wat321_bridge()` call
 *     or auto-includes as a preamble on the next dispatch.
 *   - adaptive: extend the deadline as long as the dispatcher keeps
 *     refreshing the per-turn heartbeat sidecar. Aborts cleanly when
 *     the heartbeat goes stale instead of waiting out a generic
 *     timeout that has no relationship to actual Codex liveness.
 *
 * Mode precedence: explicit per-call boolean wins over the sticky
 * status-bar flag; setting both `fire_and_forget` and `adaptive` to
 * true is a caller bug and is rejected at the dispatcher entry.
 *
 * Tracker: https://github.com/WillyDrucker/WAT321/issues
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const EH_DIR = join(homedir(), ".wat321", "epic-handshake");
const INBOX_CLAUDE_ROOT = join(EH_DIR, "inbox", "claude");
const INBOX_CODEX_ROOT = join(EH_DIR, "inbox", "codex");
const SENT_CLAUDE_ROOT = join(EH_DIR, "sent", "claude");
// Per-workspace runtime keyed off WAT321_WORKSPACE_ID (the wsHash
// injected by the extension's MCP installer). Used for both sentinel
// filenames and inbox/sent partition dirs - deriving the hash from
// cwd here would diverge from what the extension watches whenever
// Claude Code spawns the MCP process from a different cwd than the
// active VS Code workspace folder.
const WAT321_WS_ID = process.env.WAT321_WORKSPACE_ID || "default";
const PAUSED_FLAG = join(EH_DIR, `paused.${WAT321_WS_ID}.flag`);
const FIRE_AND_FORGET_FLAG = join(EH_DIR, `fire-and-forget.${WAT321_WS_ID}.flag`);
const ADAPTIVE_FLAG = join(EH_DIR, `adaptive.${WAT321_WS_ID}.flag`);
// Sidecar consumed by `WAT321_EPIC_HANDSHAKE/waitStatus.ts` so the
// Claude session-token tooltip can render "Waiting on Codex: Ns"
// while a synchronous reply wait is in flight. Per-workspace
// filename so sibling VS Code windows don't see each other's waits.

const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_SEC = 120;
const MIN_TIMEOUT_MS = 5_000;
// Adaptive-mode parameters. The dispatcher refreshes
// `turn-heartbeat.<envid>.json` on every TurnMonitor progress signal;
// adaptive considers the turn alive while the heartbeat is fresher
// than ADAPTIVE_STALE_MS, and aborts cleanly once the gap exceeds
// that (much earlier than a flat 5-minute timeout when Codex has
// genuinely hung). The hard ceiling protects against pathological
// loops where the dispatcher keeps emitting progress forever.
const ADAPTIVE_STALE_MS = 120_000;
const ADAPTIVE_HARD_CEILING_MS = 30 * 60_000;
const ADAPTIVE_DEFAULT_CEILING_MS = 10 * 60_000;

const WORKSPACE_HASH = WAT321_WS_ID;
// Envelope metadata field. Not used for routing - the partition dir
// derived from WORKSPACE_HASH above is what consumers read.
const WORKSPACE_PATH = process.env.WAT321_WORKSPACE_PATH || process.cwd();

const INBOX_CLAUDE = join(INBOX_CLAUDE_ROOT, WORKSPACE_HASH);
const INBOX_CODEX = join(INBOX_CODEX_ROOT, WORKSPACE_HASH);
const SENT_CLAUDE = join(SENT_CLAUDE_ROOT, WORKSPACE_HASH);
// Per-workspace wait sidecar, written at the start of a sync / adaptive
// wait and cleared in finally. Its fresh presence is the in-flight
// signal the dispatch guard reads to nudge against overlapping turns.
const WAIT_STATUS_PATH = join(EH_DIR, `wait-status.${WORKSPACE_HASH}.json`);

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
  // wait_mode locks the mode the MCP caller asked for into the
  // envelope so the TS dispatcher honors the same mode rather than
  // re-resolving from sticky flag files (which can disagree with the
  // per-call args). Older envelopes without the field fall through
  // to flag-based resolution on the dispatcher side.
  if (fields.waitMode) lines.push(`wait_mode: ${fields.waitMode}`);
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

/** Resolve effective wait mode from per-call args + sticky flag
 * files. Precedence:
 *   1. Per-call `fire_and_forget: true` or `adaptive: true` -> use it.
 *   2. Both true at the same time -> reject (caller bug).
 *   3. Per-call explicit `false` for either flag suppresses the
 *      matching sticky flag (lets a caller override the user's
 *      status-bar toggle for a single dispatch).
 *   4. Neither explicit -> sticky flag files. FF flag wins over
 *      adaptive flag if both somehow exist on disk (more aggressive
 *      opt-out).
 *   5. Default: sync.
 * Returns `{ mode }` on success or `{ error }` on mutual-exclusion. */
function resolveMode(args) {
  const ff =
    typeof args?.fire_and_forget === "boolean" ? args.fire_and_forget : null;
  const adp = typeof args?.adaptive === "boolean" ? args.adaptive : null;

  if (ff === true && adp === true) {
    return {
      error:
        "fire_and_forget and adaptive are mutually exclusive. Pass one or the other, never both.",
    };
  }
  if (ff === true) return { mode: "ff" };
  if (adp === true) return { mode: "adaptive" };

  const ffFlag = ff !== false && existsSync(FIRE_AND_FORGET_FLAG);
  const adpFlag = adp !== false && existsSync(ADAPTIVE_FLAG);
  if (ffFlag) return { mode: "ff" };
  if (adpFlag) return { mode: "adaptive" };
  return { mode: "sync" };
}

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

  const resolved = resolveMode(args);
  if (resolved.error) {
    return {
      content: [{ type: "text", text: resolved.error }],
      isError: true,
    };
  }

  // Overlap guard: one Codex turn per workspace at a time. If a wait is
  // already in flight, nudge the caller to wait rather than starting a
  // parallel turn (avoids the second-dispatch collision in issue #75).
  const busy = inFlightNudge();
  if (busy) return busy;

  if (resolved.mode === "sync") return runDispatch(args, prompt, "sync");
  if (resolved.mode === "adaptive") return runDispatch(args, prompt, "adaptive");

  // Fire-and-forget: wrap runDispatch in a clearable safety race so a
  // future regression that lets FF fall into a wait can't sit on a
  // dangling promise. Happy path returns sub-100ms (envelope write
  // plus immediate return); the inner runDispatch is sync-heavy and
  // not cancellable, so if the cap ever wins the dispatch keeps
  // running to completion in the background (envelope still lands,
  // late-reply file still moves - both idempotent against later
  // state).
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
              "Codex's reply, if any, will still land in the bridge inbox - retrieve it with `wat321_bridge()`. " +
              "If this recurs, restart the bridge from the status bar widget.",
          },
        ],
      });
    }, FF_SAFETY_CAP_MS);
  });
  try {
    return await Promise.race([runDispatch(args, prompt, "ff"), safetyCap]);
  } finally {
    if (safetyTimer !== null) clearTimeout(safetyTimer);
  }
}

/** Map MCP-side mode string to the envelope wait_mode string. The
 * TS extension uses "standard" / "adaptive" / "fire-and-forget" as
 * canonical terms (see `WAT321_EPIC_HANDSHAKE/waitMode.ts`); the
 * envelope adopts the same terms so the dispatcher reads them
 * without translation. */
function modeToEnvelopeWaitMode(mode) {
  if (mode === "adaptive") return "adaptive";
  if (mode === "ff") return "fire-and-forget";
  return "standard";
}

/** Common envelope-write + late-reply consume. Shared by every mode
 * so the outbound side stays identical regardless of how the bridge
 * waits for the reply. The `mode` argument is locked into envelope
 * frontmatter so the TS dispatcher applies the same wait mode the
 * MCP caller resolved, instead of re-reading sticky flag files.
 * Returns the dispatch id + the late-reply preamble (for prepending
 * to whatever the mode-specific branch returns). */
function dispatchOutbound(prompt, mode) {
  const { preamble: latePreamble, found: latePending } =
    peekLateRepliesForPreamble();

  const id = randomUUID();
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
    waitMode: modeToEnvelopeWaitMode(mode),
    body: prompt,
  });

  writeAtomic(join(INBOX_CODEX, `${id}.md`), envelope);
  // Outbound envelope is now durably on disk; safe to move the late
  // replies into `sent/`. If the writeAtomic above had thrown, the
  // late replies would still be in the inbox for the next dispatch.
  consumeLateReplyFiles(latePending);

  return { id, latePreamble };
}

/** Wrap reply body with any pending late-reply preamble. */
function withPreamble(latePreamble, body) {
  return latePreamble ? `${latePreamble}\n\n---\n\n${body}` : body;
}

/** Move a delivered reply envelope to sent/ and return its body
 * wrapped with any late-reply preamble. */
function consumeReplyAndFormat(replyMatch, latePreamble) {
  try {
    renameSync(
      join(INBOX_CLAUDE, replyMatch.filename),
      join(SENT_CLAUDE, replyMatch.filename)
    );
  } catch {
    // best-effort
  }
  return {
    content: [
      { type: "text", text: withPreamble(latePreamble, replyMatch.body) },
    ],
  };
}

async function runDispatch(args, prompt, mode) {
  const { id, latePreamble } = dispatchOutbound(prompt, mode);

  // Fire-and-forget short-circuit. The numbered guidance block is the
  // contract surface for FF: the agent returns control, does not poll,
  // and retrieves the reply via `wat321_bridge()` or the auto-preamble
  // on the next Codex dispatch.
  if (mode === "ff") {
    const ffMessage =
      `Fire-and-forget dispatch complete. The prompt was delivered to Codex and this tool returned immediately as intended - no wait was attempted, no timeout occurred, and there is nothing left for you to do for this dispatch. Dispatch id: ${id}.\n\n` +
      "What to do next:\n" +
      "1. Return control to the user right now. Do not say \"still working\", do not offer to poll, do not call this tool again for this prompt.\n" +
      "2. When the user later asks for Codex's reply (or before your next `wat321_ask` to Codex), retrieve it with `wat321_bridge()`. The reply also auto-preambles on the next `wat321_ask` to Codex, so an explicit consume is optional unless the user asks.\n" +
      "3. Never read inbox files directly with Read or cat - that desyncs the bridge and the next dispatch will inject the same reply as duplicate preamble.";
    return {
      content: [
        { type: "text", text: withPreamble(latePreamble, ffMessage) },
      ],
    };
  }

  if (mode === "adaptive") {
    return runAdaptiveWait(args, id, latePreamble);
  }

  return runSyncWait(args, id, latePreamble);
}

async function runSyncWait(args, id, latePreamble) {
  const timeoutSec =
    typeof args?.timeout_sec === "number" && Number.isFinite(args.timeout_sec)
      ? args.timeout_sec
      : DEFAULT_TIMEOUT_SEC;
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, timeoutSec * 1000);

  const waitStatusPath = WAIT_STATUS_PATH;
  writeWaitStatus(waitStatusPath, id, timeoutSec, "sync");
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
      return consumeReplyAndFormat(replyMatch, latePreamble);
    }

    const timeoutMsg = `No reply from Codex within ${Math.round(timeoutMs / 1000)}s, but the dispatch is likely still running and its reply will land in the bridge inbox. Check \`wat321_bridge()\` for it - prefer waiting over re-sending, since a second dispatch runs a parallel turn rather than replacing the first.`;
    return {
      content: [
        { type: "text", text: withPreamble(latePreamble, timeoutMsg) },
      ],
    };
  } finally {
    clearWaitStatus(waitStatusPath);
  }
}

/** Adaptive wait. The dispatcher writes
 * `turn-heartbeat.<envid>.json` on every TurnMonitor progress
 * signal. Adaptive considers the turn alive while the heartbeat's
 * `lastProgressAt` is within `ADAPTIVE_STALE_MS` and aborts cleanly
 * the moment the gap exceeds that - much earlier than a flat
 * timeout when Codex has genuinely hung. The hard ceiling caps
 * pathological loops where the dispatcher emits progress forever. */
async function runAdaptiveWait(args, id, latePreamble) {
  const requestedCeilingMs =
    typeof args?.timeout_sec === "number" && Number.isFinite(args.timeout_sec)
      ? Math.max(MIN_TIMEOUT_MS, args.timeout_sec * 1000)
      : ADAPTIVE_DEFAULT_CEILING_MS;
  const ceilingMs = Math.min(requestedCeilingMs, ADAPTIVE_HARD_CEILING_MS);

  const heartbeatPath = join(EH_DIR, `turn-heartbeat.${id}.json`);
  const waitStatusPath = WAIT_STATUS_PATH;
  writeWaitStatus(waitStatusPath, id, Math.round(ceilingMs / 1000), "adaptive");

  try {
    const hardCeiling = Date.now() + ceilingMs;
    // Grace before the first heartbeat lands. Dispatcher needs a
    // few seconds to receive the envelope, start the turn, and
    // emit the first heartbeat.
    let staleDeadline = Date.now() + ADAPTIVE_STALE_MS;
    let lastHeartbeatAt = null;

    while (Date.now() < Math.min(hardCeiling, staleDeadline)) {
      const replyMatch = findReplyEnvelope(id);
      if (replyMatch !== null) {
        return consumeReplyAndFormat(replyMatch, latePreamble);
      }
      const beat = readHeartbeat(heartbeatPath);
      if (beat !== null && typeof beat.lastProgressAt === "number") {
        lastHeartbeatAt = beat.lastProgressAt;
        staleDeadline = beat.lastProgressAt + ADAPTIVE_STALE_MS;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    // Final-tick rescue. The dispatcher may have written the
    // reply right as the deadline elapsed.
    const replyFinal = findReplyEnvelope(id);
    if (replyFinal !== null) {
      return consumeReplyAndFormat(replyFinal, latePreamble);
    }

    const hitCeiling = Date.now() >= hardCeiling;
    const stalledMs = lastHeartbeatAt === null
      ? ADAPTIVE_STALE_MS
      : Date.now() - lastHeartbeatAt;
    const msg = hitCeiling
      ? `Adaptive wait hit the ${Math.round(ceilingMs / 60_000)}-minute hard ceiling for dispatch ${id} while Codex was still emitting progress. The reply will land in the bridge inbox if it completes. Retrieve with \`wat321_bridge()\` once it arrives.`
      : `Adaptive wait aborted for dispatch ${id} - no heartbeat from the bridge dispatcher for ${Math.round(stalledMs / 1000)}s (threshold ${Math.round(ADAPTIVE_STALE_MS / 1000)}s). Codex may have hung or the dispatcher may have died; check the WAT321 Bridge output channel for detail. If Codex finishes after this, the reply will land in the bridge inbox and is retrievable via \`wat321_bridge()\`.`;
    return {
      content: [
        { type: "text", text: withPreamble(latePreamble, msg) },
      ],
    };
  } finally {
    clearWaitStatus(waitStatusPath);
  }
}

function readHeartbeat(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeWaitStatus(path, envelopeId, timeoutSec, mode) {
  try {
    writeFileSync(
      path,
      JSON.stringify({
        envelopeId,
        workspaceHash: WORKSPACE_HASH,
        target: "codex",
        timeoutSec,
        startedAt: Date.now(),
        mode,
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

/** Returns a nudge response if a Codex reply wait is already in flight
 * for this workspace, else null. runSyncWait / runAdaptiveWait write the
 * wait-status sidecar at the start of a wait and clear it in finally, so
 * its fresh presence means a dispatch is mid-wait. A second dispatch now
 * starts a parallel Codex turn (two turns on one thread collide) instead
 * of replacing or speeding up the first, so nudge the caller to wait and
 * drain via wat321_bridge(). Bounded to ADAPTIVE_STALE_MS so a sidecar
 * left behind by a killed MCP process self-expires rather than blocking
 * new dispatches - no stale-flag false positives. */
function inFlightNudge() {
  let startedAt = 0;
  try {
    if (!existsSync(WAIT_STATUS_PATH)) return null;
    const s = JSON.parse(readFileSync(WAIT_STATUS_PATH, "utf8"));
    startedAt = typeof s?.startedAt === "number" ? s.startedAt : 0;
  } catch {
    // best-effort: an unreadable or corrupt sidecar means allow the dispatch
    return null;
  }
  if (Date.now() - startedAt >= ADAPTIVE_STALE_MS) return null;
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  return {
    content: [
      {
        type: "text",
        text:
          `A Codex dispatch is already in flight on this workspace (started ${elapsedSec}s ago). ` +
          "Codex runs one turn at a time, and a second dispatch starts a parallel turn rather than replacing or speeding up the first. " +
          "Wait for the in-flight reply and drain it with `wat321_bridge()` instead of sending another. No need to gauge timing - just avoid overlapping dispatches.",
      },
    ],
  };
}

/** Handle a `wat321_bridge` MCP tool call. Single-purpose: drain the
 * bridge inbox. Accepts missing/null `action` and the legacy
 * `"consume"` value for back-compat; rejects anything else explicitly
 * so a hallucinated `action: "status"` or `"restart"` doesn't silently
 * drain the inbox. */
export async function handleBridge(args) {
  const action = args?.action;
  const validAction =
    action === undefined ||
    action === null ||
    (typeof action === "string" && action.trim() === "consume");
  if (!validAction) {
    return {
      content: [
        {
          type: "text",
          text: `wat321_bridge: unknown action '${String(action)}'. The tool drains the inbox - omit \`action\` entirely, or pass \`action: "consume"\` for back-compat. No action was taken; nothing was consumed.`,
        },
      ],
      isError: true,
    };
  }
  return bridgeConsume(args);
}

/** `wat321_bridge` body. Drains pending late replies from the bridge
 * inbox - returns the bodies AND atomically moves the source files to
 * sent/. This is the documented retrieval path for fire-and-forget
 * replies; without it, callers reach for direct file reads which leave
 * the inbox non-empty and cause the next dispatch to inject the same
 * reply as duplicate preamble.
 *
 * Args:
 *   - reply_id (optional): consume one specific reply matching the
 *     given id (matched against filename or envelope chain_id).
 *     Omit to drain all pending replies. */
async function bridgeConsume(args) {
  ensureDirs();
  const replyId =
    typeof args?.reply_id === "string" && args.reply_id.trim().length > 0
      ? args.reply_id.trim()
      : null;

  const all = scanLateReplies();
  if (all.length === 0) {
    // Empty content means "nothing from Codex to drain." The
    // channel.mjs `dispatchBridgeDrain` combiner uses this to decide
    // whether to show the unified empty-state message - if non-Codex
    // also has nothing the combiner emits the empty message, otherwise
    // it skips this branch entirely and just returns the non-Codex
    // reply. Returning the empty-state text here caused the next
    // dispatch to look like a partial failure: agents saw "No pending
    // replies" followed by the actual non-Codex reply and reported
    // the call as failed even though the data was there.
    return { content: [] };
  }

  let toConsume;
  if (replyId !== null) {
    toConsume = all.filter((r) => {
      if (r.filename === `${replyId}.md`) return true;
      if (r.filename.startsWith(`${replyId}.`)) return true;
      // Also match envelope chain id, parsed via the envelope reader.
      try {
        const raw = readFileSync(r.sourcePath, "utf8");
        const parsed = parseEnvelope(raw);
        if (parsed?.fields?.chain_id === replyId) return true;
        if (parsed?.fields?.reply_to === replyId) return true;
        if (parsed?.fields?.id === replyId) return true;
      } catch {
        // best-effort
      }
      return false;
    });
    if (toConsume.length === 0) {
      const pendingIds = all.map((r) => r.filename.replace(/\.md$/, ""));
      return {
        content: [
          {
            type: "text",
            text: `No reply matching id '${replyId}' in the bridge inbox. Pending ids: ${pendingIds.join(", ")}.`,
          },
        ],
        isError: true,
      };
    }
  } else {
    toConsume = all;
  }

  const chunks = toConsume.map(
    (r, i) =>
      `[Reply ${i + 1}/${toConsume.length} from Codex, originally sent ${r.createdAt || "earlier"}]\n${r.body}`
  );
  const text = chunks.join("\n\n---\n\n");

  // Move the source files only AFTER the bodies have been formatted
  // for return. If formatting throws (it shouldn't, but) the inbox
  // stays intact for a retry.
  consumeLateReplyFiles(toConsume);

  return { content: [{ type: "text", text }] };
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
        ? "Late replies are queued. Retrieve them with `wat321_bridge()` (drains the inbox and returns the bodies), or they auto-include as a preamble on the next Codex dispatch."
        : "Inbox is empty.",
  };
}
