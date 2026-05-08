import { existsSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Wait-status sidecar writer. The file lets the EH widget render
 * "Waiting on Codex: Ns" while a dispatch is in flight. Shape stays
 * minimal - `timeoutSec` is the only payload the tooltip needs;
 * `startedAt` lets future surfaces compute remaining time without
 * re-rendering on a tick.
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
