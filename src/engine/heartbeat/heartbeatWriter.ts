import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../fs/atomicWrite";
import { EPIC_HANDSHAKE_DIR } from "../wat321Paths";
import type { Heartbeat } from "./heartbeatTypes";

/**
 * Atomic heartbeat writer. Every dispatcher calls this on each
 * progress signal, and `heartbeatReader.ts` finds every backend's
 * heartbeat in one place:
 *
 *   `<EPIC_HANDSHAKE_DIR>/turn-heartbeat.<dispatchId>.json`
 *
 * Cross-workspace isolation comes from the `workspaceHash` field on
 * the heartbeat itself, which the reader filters on. Atomic tmp+rename
 * is load-bearing: the reader runs concurrent with the writer and
 * would otherwise observe a mid-flush file as a JSON parse error.
 */

function heartbeatPath(dispatchId: string): string {
  return join(EPIC_HANDSHAKE_DIR, `turn-heartbeat.${dispatchId}.json`);
}

export function writeHeartbeat(hb: Heartbeat): void {
  const path = heartbeatPath(hb.dispatchId);
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileAtomic(path, JSON.stringify(hb, null, 2));
}

/** Remove the heartbeat file for a finished dispatch. Best-effort -
 * a leftover heartbeat eventually times out via the staleness gate
 * on the reader side, but explicit cleanup keeps the EH dir tidy. */
export function deleteHeartbeat(dispatchId: string): void {
  const path = heartbeatPath(dispatchId);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}
