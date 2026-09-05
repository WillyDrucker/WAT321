import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { WAIT_STATUS_PATH, WORKSPACE_HASH } from "../epicHandshakePaths.mjs";
import { textResult } from "../mcpResults.mjs";
import { ADAPTIVE_STALE_MS } from "./waitTimings.mjs";
import { writeFileAtomic } from "../atomicWrite.mjs";

/**
 * The wait-status sidecar: written when a sync or adaptive wait
 * starts, cleared in finally. Its fresh presence means a Codex turn is
 * mid-wait on this workspace, which the dispatch guard turns into a
 * nudge (one Codex turn per workspace at a time) and the Claude
 * session-token tooltip renders as "Waiting on Codex: Ns".
 */

export function writeWaitStatus(envelopeId, timeoutSec, mode) {
  try {
    writeFileAtomic(
      WAIT_STATUS_PATH,
      JSON.stringify({
        envelopeId,
        workspaceHash: WORKSPACE_HASH,
        target: "codex",
        timeoutSec,
        startedAt: Date.now(),
        mode,
      })
    );
  } catch {
    // best-effort
  }
}

export function clearWaitStatus() {
  try {
    if (existsSync(WAIT_STATUS_PATH)) unlinkSync(WAIT_STATUS_PATH);
  } catch {
    // best-effort
  }
}

/** A nudge response when a reply wait is already in flight for this
 * workspace, else null. A second dispatch now would start a parallel
 * Codex turn (two turns on one thread collide) instead of replacing
 * or speeding up the first, so the caller is told to wait and drain
 * via wat321_bridge(). Bounded to ADAPTIVE_STALE_MS so a sidecar left
 * behind by a killed MCP process self-expires rather than blocking new
 * dispatches. */
export function inFlightNudge() {
  let startedAt = 0;
  try {
    if (!existsSync(WAIT_STATUS_PATH)) return null;
    const s = JSON.parse(readFileSync(WAIT_STATUS_PATH, "utf8"));
    startedAt = typeof s?.startedAt === "number" ? s.startedAt : 0;
  } catch {
    // an unreadable or corrupt sidecar means allow the dispatch
    return null;
  }
  if (Date.now() - startedAt >= ADAPTIVE_STALE_MS) return null;
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  return textResult(
    `A Codex dispatch is already in flight on this workspace (started ${elapsedSec}s ago). ` +
      "Codex runs one turn at a time, and a second dispatch starts a parallel turn rather than replacing or speeding up the first. " +
      "Wait for the in-flight reply and drain it with `wat321_bridge()` instead of sending another. No need to gauge timing - just avoid overlapping dispatches."
  );
}
