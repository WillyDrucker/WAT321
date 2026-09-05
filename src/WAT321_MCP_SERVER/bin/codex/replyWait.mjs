import {
  MIN_TIMEOUT_MS,
  requestedTimeoutSec,
  timeoutMsFor,
} from "../dispatchTimeout.mjs";
import { textResult } from "../mcpResults.mjs";
import { readTurnHeartbeat } from "../turnHeartbeat.mjs";
import {
  consumeReplyAndFormat,
  findReplyEnvelope,
  withPreamble,
} from "./mailbox.mjs";
import { clearWaitStatus, writeWaitStatus } from "./waitStatus.mjs";
import {
  ADAPTIVE_DEFAULT_CEILING_MS,
  ADAPTIVE_HARD_CEILING_MS,
  ADAPTIVE_STALE_MS,
  POLL_INTERVAL_MS,
} from "./waitTimings.mjs";

/**
 * The two blocking waits for a Codex reply. Sync polls the inbox
 * until `timeout_sec`. Adaptive extends the deadline as long as the
 * dispatcher keeps refreshing the per-turn heartbeat and aborts
 * cleanly when the heartbeat goes stale, instead of waiting out a
 * generic timeout that has no relationship to actual Codex liveness.
 * Both write the wait-status sidecar for the duration.
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runSyncWait(args, id, latePreamble) {
  const timeoutSec = requestedTimeoutSec(args);
  const timeoutMs = timeoutMsFor(timeoutSec);

  writeWaitStatus(id, timeoutSec, "sync");
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
    return textResult(withPreamble(latePreamble, timeoutMsg));
  } finally {
    clearWaitStatus();
  }
}

export async function runAdaptiveWait(args, id, latePreamble) {
  const requestedCeilingMs =
    typeof args?.timeout_sec === "number" && Number.isFinite(args.timeout_sec)
      ? Math.max(MIN_TIMEOUT_MS, args.timeout_sec * 1000)
      : ADAPTIVE_DEFAULT_CEILING_MS;
  const ceilingMs = Math.min(requestedCeilingMs, ADAPTIVE_HARD_CEILING_MS);

  writeWaitStatus(id, Math.round(ceilingMs / 1000), "adaptive");
  try {
    const hardCeiling = Date.now() + ceilingMs;
    // Grace before the first heartbeat lands. The dispatcher needs a
    // few seconds to receive the envelope, start the turn, and emit
    // the first heartbeat.
    let staleDeadline = Date.now() + ADAPTIVE_STALE_MS;
    let lastHeartbeatAt = null;

    while (Date.now() < Math.min(hardCeiling, staleDeadline)) {
      const replyMatch = findReplyEnvelope(id);
      if (replyMatch !== null) {
        return consumeReplyAndFormat(replyMatch, latePreamble);
      }
      const beat = readTurnHeartbeat(id);
      if (beat !== null && typeof beat.lastProgressAt === "number") {
        lastHeartbeatAt = beat.lastProgressAt;
        staleDeadline = beat.lastProgressAt + ADAPTIVE_STALE_MS;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    // Final-tick rescue. The dispatcher may have written the reply
    // right as the deadline elapsed.
    const replyFinal = findReplyEnvelope(id);
    if (replyFinal !== null) {
      return consumeReplyAndFormat(replyFinal, latePreamble);
    }

    const hitCeiling = Date.now() >= hardCeiling;
    const stalledMs =
      lastHeartbeatAt === null ? ADAPTIVE_STALE_MS : Date.now() - lastHeartbeatAt;
    const msg = hitCeiling
      ? `Adaptive wait hit the ${Math.round(ceilingMs / 60_000)}-minute hard ceiling for dispatch ${id} while Codex was still emitting progress. The reply will land in the bridge inbox if it completes. Retrieve with \`wat321_bridge()\` once it arrives.`
      : `Adaptive wait aborted for dispatch ${id} - no heartbeat from the bridge dispatcher for ${Math.round(stalledMs / 1000)}s (threshold ${Math.round(ADAPTIVE_STALE_MS / 1000)}s). Codex may have hung or the dispatcher may have died; check the WAT321 Bridge output channel for detail. If Codex finishes after this, the reply will land in the bridge inbox and is retrievable via \`wat321_bridge()\`.`;
    return textResult(withPreamble(latePreamble, msg));
  } finally {
    clearWaitStatus();
  }
}
