import { RECOVERY_CEILING_MS, RECOVERY_TICK_MS } from "./constants";
import type {
  TransitionReason,
  TransitionStatus,
} from "./transitionLog";
import type {
  TransitionLogger,
  TransitionSnapshot,
} from "./usageServiceTransitionLogger";

/**
 * Independent recovery watchdog for the polling service. Ticks at
 * `RECOVERY_TICK_MS` (60s) and checks the gap since the last real
 * HTTPS attempt. When the gap exceeds `RECOVERY_CEILING_MS` (15
 * min) and the service is in a non-ok / non-not-connected / no-auth
 * state, forces a fetch that bypasses cache adoption so a stuck
 * `token-expired` or a long `rate-limited` park always gets at
 * least one real attempt per quarter-hour. Replaces "user must
 * prompt to recover" with "the service heals itself on its own
 * clock."
 *
 * `ok` skips because there is nothing to recover from.
 * `not-connected` skips because the discovery poller owns recovery.
 * `no-auth` skips because the main poll loop revisits getAuth()
 * every POLL_INTERVAL_MS already - the watchdog would log
 * recovery-ceiling-hit every minute without making progress.
 */

export interface RecoveryWatchdogDeps {
  /** Current service status. The watchdog skips the recovery path
   * for ok / not-connected / no-auth. */
  getCurrentStatus(): TransitionStatus;
  /** Wall-clock ms of the last actual HTTPS attempt (updated by
   * doFetch, NOT by cache adoption). */
  getLastFetchAttemptMs(): number;
  /** Is the service currently disposed? Skip the tick if so. */
  isDisposed(): boolean;
  /** Is a fetch currently in flight? Skip the tick if so to avoid
   * piling on. */
  isInFlight(): boolean;
  /** Force a refresh that bypasses cache adoption. The base class
   * calls `refresh(true)` from this seam. */
  forceRefresh(): void;
  /** Build a transition snapshot for the recovery-ceiling-hit
   * heartbeat record. */
  buildSnapshot(): TransitionSnapshot;
  /** Logger for the same-status heartbeat record. */
  transitionLogger: TransitionLogger;
}

export interface RecoveryWatchdog {
  /** Stop the watchdog ticker and release the timer. */
  dispose(): void;
}

/** Start a recovery watchdog timer. Returns a handle whose
 * `dispose()` clears the timer. The watchdog runs until disposed
 * even if the service goes idle - the next non-ok / non-not-connected
 * tick will fire a forced refresh. */
export function startRecoveryWatchdog(
  deps: RecoveryWatchdogDeps
): RecoveryWatchdog {
  const tick = (): void => {
    if (deps.isDisposed()) return;
    if (deps.isInFlight()) return;
    const status = deps.getCurrentStatus();
    if (status === "ok") return;
    if (status === "not-connected") return;
    if (status === "no-auth") return;
    const sinceLastFetch = Date.now() - deps.getLastFetchAttemptMs();
    if (sinceLastFetch < RECOVERY_CEILING_MS) return;
    deps.transitionLogger.recordHeartbeat({
      status,
      reason: "recovery-ceiling-hit" as TransitionReason,
      snapshot: deps.buildSnapshot(),
    });
    deps.forceRefresh();
  };
  const timer = setInterval(tick, RECOVERY_TICK_MS);
  return {
    dispose: (): void => {
      clearInterval(timer);
    },
  };
}
