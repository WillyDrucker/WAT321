import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../../shared/fs/atomicWrite";
import { EH_ROOT_DIR } from "../inbox/inboxPaths";
import type { Heartbeat } from "./heartbeatTypes";

/**
 * Atomic heartbeat writer. Both Codex and non-Codex dispatchers call
 * this on every progress signal. Path layout is shared across tiers:
 *
 *   `<EH_ROOT_DIR>/turn-heartbeat.<dispatchId>.json`
 *
 * Codex uses the Epic Handshake root because that's where its
 * historical heartbeat layout lives. Non-Codex dispatchers also write
 * there (rather than the per-client bridge state dir) so the bridge
 * stage coordinator's existing reader continues to find every
 * backend's heartbeat in one place. Cross-workspace isolation comes
 * from the `workspaceHash` field on the heartbeat itself, which the
 * reader filters on.
 */

function heartbeatPath(dispatchId: string): string {
  return join(EH_ROOT_DIR, `turn-heartbeat.${dispatchId}.json`);
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
