import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomicWrite.mjs";
import {
  ADAPTIVE_FLAG_PATH,
  FIRE_AND_FORGET_FLAG_PATH,
  INBOX_CODEX_DIR,
  PAUSED_FLAG_PATH,
  WORKSPACE_PATH,
} from "../epicHandshakePaths.mjs";
import { errorResult, textResult } from "../mcpResults.mjs";
import { buildEnvelope } from "./envelope.mjs";
import {
  consumeLateReplyFiles,
  ensureMailboxDirs,
  peekLateRepliesForPreamble,
  withPreamble,
} from "./mailbox.mjs";
import { runAdaptiveWait, runSyncWait } from "./replyWait.mjs";
import { inFlightNudge } from "./waitStatus.mjs";
import { FF_SAFETY_CAP_MS } from "./waitTimings.mjs";

/**
 * Codex target handler for `wat321_ask`. Three wait modes:
 *
 *   - sync: poll for the reply until `timeout_sec` (default 120s).
 *   - fire-and-forget: write the envelope, return immediately. The
 *     reply lands in the per-workspace inbox for a later
 *     `wat321_bridge()` call or auto-includes as a preamble on the
 *     next dispatch.
 *   - adaptive: extend the deadline as long as the dispatcher keeps
 *     refreshing the per-turn heartbeat (see `replyWait.mjs`).
 *
 * Mode precedence: an explicit per-call boolean wins over the sticky
 * status-bar flag. Setting both `fire_and_forget` and `adaptive` to
 * true is a caller bug and is rejected at entry.
 */

/** Per-process fingerprint stamped onto outbound envelopes so the
 * dispatcher can identify which server originated a request. Outbound
 * only, for diagnostics and dispatcher hints. Inbound routing never
 * matches against it (see `mailbox.mjs`). */
const SESSION_FP = randomUUID();

/** Resolve the effective wait mode from per-call args + sticky flag
 * files. Precedence:
 *   1. Per-call `fire_and_forget: true` or `adaptive: true` -> use it.
 *   2. Both true at the same time -> reject (caller bug).
 *   3. An explicit `fire_and_forget: false` (or `adaptive: false`)
 *      with no other escalation flag forces plain sync. Both sticky
 *      flag files are suppressed so the caller can override the
 *      user's status-bar toggle for a single dispatch and actually
 *      get sync rather than silently running adaptive.
 *   4. Explicit `false` for one flag with `true` for the other still
 *      honors the explicit `true`.
 *   5. Neither explicit -> sticky flag files. FF wins over adaptive
 *      if both somehow exist on disk (more aggressive opt-out).
 *   6. Default: sync.
 * Returns `{ mode }` on success or `{ error }` on mutual exclusion. */
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

  const explicitSyncOptOut = ff === false || adp === false;
  const ffFlag = !explicitSyncOptOut && existsSync(FIRE_AND_FORGET_FLAG_PATH);
  const adpFlag = !explicitSyncOptOut && existsSync(ADAPTIVE_FLAG_PATH);
  if (ffFlag) return { mode: "ff" };
  if (adpFlag) return { mode: "adaptive" };
  return { mode: "sync" };
}

/** The extension uses "standard" / "adaptive" / "fire-and-forget" as
 * canonical terms (see `WAT321_EPIC_HANDSHAKE/codexTurn/waitMode.ts`). The
 * envelope adopts the same terms so the dispatcher reads them
 * without translation. */
function modeToEnvelopeWaitMode(mode) {
  if (mode === "adaptive") return "adaptive";
  if (mode === "ff") return "fire-and-forget";
  return "standard";
}

/** Envelope write + late-reply consume, shared by every mode so the
 * outbound side stays identical regardless of how the bridge waits
 * for the reply. The mode is locked into the envelope frontmatter so
 * the TS dispatcher applies the same wait mode the MCP caller
 * resolved instead of re-reading sticky flag files. */
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

  writeFileAtomic(join(INBOX_CODEX_DIR, `${id}.md`), envelope);
  // The outbound envelope is now durably on disk, so the late replies
  // can move into `sent/`. Had the write thrown, they would still be
  // in the inbox for the next dispatch.
  consumeLateReplyFiles(latePending);

  return { id, latePreamble };
}

/** The contract surface for fire-and-forget: the agent returns
 * control, does not poll, and retrieves the reply via
 * `wat321_bridge()` or the auto-preamble on the next Codex dispatch. */
function ffCompleteMessage(id) {
  return (
    `Fire-and-forget dispatch complete. The prompt was delivered to Codex and this tool returned immediately as intended - no wait was attempted, no timeout occurred, and there is nothing left for you to do for this dispatch. Dispatch id: ${id}.\n\n` +
    "What to do next:\n" +
    "1. Return control to the user right now. Do not say \"still working\", do not offer to poll, do not call this tool again for this prompt.\n" +
    "2. When the user later asks for Codex's reply (or before your next `wat321_ask` to Codex), retrieve it with `wat321_bridge()`. The reply also auto-preambles on the next `wat321_ask` to Codex, so an explicit consume is optional unless the user asks.\n" +
    "3. Never read inbox files directly with Read or cat - that desyncs the bridge and the next dispatch will inject the same reply as duplicate preamble."
  );
}

async function runDispatch(args, prompt, mode) {
  const { id, latePreamble } = dispatchOutbound(prompt, mode);
  if (mode === "ff") {
    return textResult(withPreamble(latePreamble, ffCompleteMessage(id)));
  }
  if (mode === "adaptive") return runAdaptiveWait(args, id, latePreamble);
  return runSyncWait(args, id, latePreamble);
}

/** Handle a `wat321_ask({target: "codex", ...})` call. */
export async function handleAsk(args) {
  ensureMailboxDirs();

  const prompt = typeof args?.prompt === "string" ? args.prompt : "";
  if (prompt.trim().length === 0) {
    return errorResult("Expected a non-empty `prompt` argument for target=codex.");
  }

  if (existsSync(PAUSED_FLAG_PATH)) {
    return textResult(
      "Epic Handshake is paused. Resume from the status bar widget to dispatch new prompts."
    );
  }

  const resolved = resolveMode(args);
  if (resolved.error) return errorResult(resolved.error);

  // Overlap guard: one Codex turn per workspace at a time. A wait
  // already in flight nudges the caller to wait rather than starting
  // a parallel turn that collides with the first.
  const busy = inFlightNudge();
  if (busy) return busy;

  if (resolved.mode !== "ff") return runDispatch(args, prompt, resolved.mode);

  // Fire-and-forget: wrap runDispatch in a clearable safety race so a
  // future regression that lets FF fall into a wait cannot sit on a
  // dangling promise. The inner runDispatch is sync-heavy and not
  // cancellable, so if the cap ever wins the dispatch keeps running
  // to completion in the background (envelope still lands, late-reply
  // files still move, both idempotent against later state).
  let safetyTimer = null;
  const safetyCap = new Promise((resolve) => {
    safetyTimer = setTimeout(() => {
      safetyTimer = null;
      resolve(
        textResult(
          `Fire-and-forget safety cap reached at ${Math.round(FF_SAFETY_CAP_MS / 1000)}s. ` +
            "The bridge held the dispatch longer than fire-and-forget's no-wait contract allows; this is unexpected. " +
            "Codex's reply, if any, will still land in the bridge inbox - retrieve it with `wat321_bridge()`. " +
            "If this recurs, restart the bridge from the status bar widget."
        )
      );
    }, FF_SAFETY_CAP_MS);
  });
  try {
    return await Promise.race([runDispatch(args, prompt, "ff"), safetyCap]);
  } finally {
    if (safetyTimer !== null) clearTimeout(safetyTimer);
  }
}
