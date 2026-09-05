/** `process.kill(pid, 0)` is the portable Node liveness check. Signal
 * 0 is test-only and never delivered. ESRCH means the process is gone,
 * EPERM means alive but not ours to signal, which still counts as
 * alive here. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
}
