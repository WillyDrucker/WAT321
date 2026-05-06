import { existsSync, unlinkSync } from "node:fs";
import { writeFileAtomic } from "./atomicWrite";

/**
 * Flag-file primitives for cross-process sentinels. A flag is a tiny file
 * whose presence carries the signal; its contents (an ISO timestamp) are
 * only used when a freshness window matters. Both the Epic Handshake
 * dispatcher (`turnFlags.ts`) and the Model Bridge click menu
 * (`runtimeFlags.ts`) write the same shape; this module is the shared
 * floor so the try/catch + best-effort contract stays consistent.
 *
 * All operations are best-effort by design. A flag-write that fails costs
 * a missed animation frame or a missed cancel; never block real work on
 * flag I/O. Callers do NOT need their own try/catch around these.
 */

/** Atomic write of an ISO timestamp. Best-effort; failures are swallowed. */
export function setFlag(path: string): void {
  try {
    writeFileAtomic(path, new Date().toISOString());
  } catch {
    // best-effort
  }
}

/** Unlink the flag if present. Best-effort; failures are swallowed. */
export function clearFlag(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}
