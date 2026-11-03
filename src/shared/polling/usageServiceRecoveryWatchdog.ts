import { RECOVERY_CEILING_MS, RECOVERY_TICK_MS } from "./pollingTimings";
import type { TransitionStatus } from "../../engine/usageTransitionLog";
import type {
  TransitionLogger,
  TransitionSnapshot,
} from "./usageServiceTransitionLogger";

/**
 * Independent recovery watchdog for the polling service. Every
 * `RECOVERY_TICK_MS` it checks the gap since the last real HTTPS attempt,
 * and past `RECOVERY_CEILING_MS` it forces a fetch that bypasses cache
 * adoption, so a stuck `token-expired` or a long `rate-limited` park
 * still gets a real attempt on the service's own clock.
 *
 * `ok` skips because there is nothing to recover from.
 * `not-connected` skips because the discovery poller owns recovery.
 * `no-auth` skips because the main poll loop already revisits getAuth()
 * every poll, and the watchdog would only log a ceiling hit each tick.
 */

export interface RecoveryWatchdogDeps {
  /** Current service status. The watchdog skips the recovery path
   * for ok / not-connected / no-auth. */
  getCurrentStatus(): TransitionStatus;
  /** Wall-clock ms of the last actual HTTPS attempt, set only when a
   * request goes out and never by cache adoption. */
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
      reason: "recovery-ceiling-hit",
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
