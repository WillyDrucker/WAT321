import { existsSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Wait-status sidecar writer. The file lets the EH widget render
 * "Waiting on Codex: Ns" while a dispatch is in flight. Shape stays
 * minimal - `timeoutSec` is what the tooltip reads; `startedAt`
 * carries the dispatch instant so the reader can drop stale files
 * (heartbeat absent + startedAt older than the cutoff).
 */

export function writeWaitStatus(waitStatusPath, workspaceHash, envelopeId, timeoutSec) {
  try {
    writeFileSync(
      waitStatusPath,
      JSON.stringify({
        envelopeId,
        workspaceHash,
        target: "codex",
        timeoutSec,
        startedAt: Date.now(),
      }),
      "utf8"
    );
  } catch {
    // Best-effort: failing to write the sidecar must not break the
    // actual dispatch.
  }
}

export function clearWaitStatus(waitStatusPath) {
  try {
    if (existsSync(waitStatusPath)) unlinkSync(waitStatusPath);
  } catch {
    // best-effort
  }
}
