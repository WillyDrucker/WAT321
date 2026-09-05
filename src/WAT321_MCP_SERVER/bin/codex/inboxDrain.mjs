import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { INBOX_CODEX_DIR, WORKSPACE_HASH } from "../epicHandshakePaths.mjs";
import { errorResult, textResult } from "../mcpResults.mjs";
import { listTurnHeartbeats } from "../turnHeartbeat.mjs";
import { parseEnvelope } from "./envelope.mjs";
import {
  consumeLateReplyFiles,
  ensureMailboxDirs,
  scanLateReplies,
} from "./mailbox.mjs";
import { ADAPTIVE_STALE_MS } from "./waitTimings.mjs";

/**
 * `wat321_bridge` for Codex: drain the late replies queued in this
 * workspace's mailbox, plus the in-flight summary the combined drain
 * shows when nothing has landed yet. Draining is the documented
 * retrieval path for fire-and-forget replies. Without it, callers
 * reach for direct file reads which leave the inbox non-empty and
 * cause the next dispatch to inject the same reply as duplicate
 * preamble.
 */

/** Accepts missing/null `action` and the legacy `"consume"` value for
 * back-compat. Anything else is rejected explicitly so a hallucinated
 * `action: "status"` or `"restart"` does not silently drain the inbox. */
export async function handleBridge(args) {
  const action = args?.action;
  const validAction =
    action === undefined ||
    action === null ||
    (typeof action === "string" && action.trim() === "consume");
  if (!validAction) {
    return errorResult(
      `wat321_bridge: unknown action '${String(action)}'. The tool drains the inbox - omit \`action\` entirely, or pass \`action: "consume"\` for back-compat. No action was taken; nothing was consumed.`
    );
  }
  return bridgeConsume(args);
}

/** Returns the bodies AND atomically moves the source files to sent/.
 * `reply_id` (optional) consumes one specific reply matched against
 * the filename or the envelope ids. Empty content means "nothing from
 * Codex to drain": the combined drain uses that to decide whether to
 * show the unified empty-state message, since an empty-state text
 * stapled in front of a non-Codex reply reads as a partial failure. */
async function bridgeConsume(args) {
  ensureMailboxDirs();
  const replyId =
    typeof args?.reply_id === "string" && args.reply_id.trim().length > 0
      ? args.reply_id.trim()
      : null;

  const all = scanLateReplies();
  if (all.length === 0) return { content: [] };

  let toConsume = all;
  if (replyId !== null) {
    toConsume = all.filter((r) => {
      if (r.filename === `${replyId}.md`) return true;
      if (r.filename.startsWith(`${replyId}.`)) return true;
      try {
        const parsed = parseEnvelope(readFileSync(r.sourcePath, "utf8"));
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
      return errorResult(
        `No reply matching id '${replyId}' in the bridge inbox. Pending ids: ${pendingIds.join(", ")}.`
      );
    }
  }

  const chunks = toConsume.map(
    (r, i) =>
      `[Reply ${i + 1}/${toConsume.length} from Codex, originally sent ${r.createdAt || "earlier"}]\n${r.body}`
  );
  const text = chunks.join("\n\n---\n\n");

  // Move the source files only AFTER the bodies have been formatted
  // for return, so a formatting throw leaves the inbox intact for a
  // retry.
  consumeLateReplyFiles(toConsume);

  return textResult(text);
}

/** Outbound dispatches the extension's CodexDispatcher has not yet
 * claimed, with age from file mtime. */
function queuedEnvelopeEntries() {
  const entries = [];
  try {
    if (!existsSync(INBOX_CODEX_DIR)) return entries;
    for (const file of readdirSync(INBOX_CODEX_DIR).filter((f) => f.endsWith(".md"))) {
      const path = join(INBOX_CODEX_DIR, file);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      entries.push({
        kind: existsSync(`${path}.claim`) ? "claimed" : "queued",
        id: file.replace(/\.md$/, ""),
        stage: null,
        ageSec: Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000)),
        staleSec: null,
      });
    }
  } catch {
    // best-effort
  }
  return entries;
}

/** Active or wedged Codex turns from the heartbeat sidecars, with the
 * latest stage and the gap from now to `lastProgressAt`. Stale (past
 * ADAPTIVE_STALE_MS) reads as "stuck", fresh as "working". */
function heartbeatEntries() {
  const entries = [];
  for (const beat of listTurnHeartbeats(WORKSPACE_HASH)) {
    const id = typeof beat?.envelopeId === "string" ? beat.envelopeId : null;
    if (id === null) continue;
    const lastProgressAt =
      typeof beat?.lastProgressAt === "number" ? beat.lastProgressAt : null;
    const staleSec =
      lastProgressAt === null
        ? null
        : Math.max(0, Math.floor((Date.now() - lastProgressAt) / 1000));
    const turnStartedAt =
      typeof beat?.turnStartedAt === "number" ? beat.turnStartedAt : null;
    const ageSec =
      turnStartedAt === null
        ? 0
        : Math.max(0, Math.floor((Date.now() - turnStartedAt) / 1000));
    const isStale = staleSec !== null && staleSec * 1000 > ADAPTIVE_STALE_MS;
    entries.push({
      kind: isStale ? "stuck" : "working",
      id,
      stage: typeof beat?.stage === "string" ? beat.stage : null,
      ageSec,
      staleSec,
    });
  }
  return entries;
}

/** One summary entry per in-flight Codex envelope or heartbeat for
 * THIS workspace, oldest first so the longest-running turn (most
 * likely needing user attention) leads. Drives the wat321_bridge
 * empty-state so the agent can report "Codex is still working on it"
 * honestly instead of the generic "nothing to wait on" when a turn IS
 * mid-flight or wedged. A heartbeat wins over a queued entry for the
 * same id because it carries stage detail. */
export function inFlightCodexSummary() {
  const entries = queuedEnvelopeEntries();
  for (const beat of heartbeatEntries()) {
    const dupeIdx = entries.findIndex((e) => e.id === beat.id);
    if (dupeIdx >= 0) entries.splice(dupeIdx, 1);
    entries.push(beat);
  }
  entries.sort((a, b) => b.ageSec - a.ageSec);
  return entries;
}
