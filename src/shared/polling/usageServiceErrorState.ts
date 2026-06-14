import type { ServiceState } from "../../engine/serviceTypes";
import {
  AUTH_ERROR_CODES,
  COLD_START_ABSORPTION_THRESHOLD,
  ERROR_ABSORPTION_THRESHOLD,
  NETWORK_ERROR_ABSORPTION_THRESHOLD,
  NETWORK_ERROR_RETRY_MS,
  POLL_INTERVAL_MS,
  RATE_LIMIT_BACKOFF_MS,
} from "./constants";
import {
  extractServerMessage,
  isNetworkError,
} from "./errorClassification";
import { HttpError } from "./httpError";
import { isCacheableState } from "./stateMachine";
import type { KickstartGate } from "./kickstartGate";
import type {
  TransitionLogger,
  TransitionSnapshot,
} from "./usageServiceTransitionLogger";
import type { TransitionReason } from "./transitionLog";

/**
 * Error-side state machine for `UsageServiceBase`. Owns the three
 * consecutive counters (rate-limits, errors, cold-start absorbs)
 * and the full `handleFetchError` decision tree. Lives in its own
 * class so the base service file is not dominated by error
 * classification - the counters move together, the cold-start
 * absorption rules move together, and the dispatch into `setState` /
 * `setPollInterval` / cache write is the only seam the base file
 * needs to wire.
 *
 * On success, `recordSuccess()` clears all counters and resets the
 * kickstart escalation. The base class's refresh-ok path calls it
 * once instead of touching three private fields itself.
 */

export interface ErrorStateDeps {
  /** Read the current service state (needed for cold-start
   * absorption and error-during-loading branches). */
  getCurrentState(): ServiceState<unknown>;
  /** Apply a new state with a transition reason. Same shape as the
   * base class's setState. */
  setState(state: ServiceState<unknown>, reason: TransitionReason): void;
  /** Replace the active poll interval (and reset the timer). */
  setPollInterval(ms: number): void;
  /** Persist a state to the shared cache for cross-window adoption. */
  writeCache(state: ServiceState<unknown>): void;
  /** Start the rate-limit countdown ticker. */
  startCountdown(): void;
  /** Kickstart gate for cold-start probe + strike consumption. */
  kickstart: KickstartGate;
  /** Transition logger for the ok->ok absorbed-429 record. */
  transitionLogger: TransitionLogger;
  /** Snapshot getter for transition log records. The base class
   * computes idleForMs / poll interval, so the error handler asks
   * for it on demand. */
  buildSnapshot(): TransitionSnapshot;
}

export class UsageServiceErrorState {
  private consecutiveRateLimits = 0;
  private consecutiveErrors = 0;
  /** Transient 429s tagged cold-start that we have absorbed while
   * an ok state is on display. The usage endpoint cold-polls 429 on
   * brief idle gaps (most visibly at the 5h billing-window rollover).
   * Flipping the widget straight to the "Idle" skin violates the
   * last-known-good principle - the user just had valid numbers a
   * minute ago. We keep rendering the prior ok state for a few more
   * polls, then fall through to the full rate-limited park if the
   * cold-start persists. Counter resets on any successful fetch. */
  private consecutiveColdStartAbsorbs = 0;

  constructor(private readonly deps: ErrorStateDeps) {}

  /** Public read for the diagnostics object + the transition
   * snapshot the base class assembles. */
  getColdStartAbsorbs(): number {
    return this.consecutiveColdStartAbsorbs;
  }

  /** Did the most recent fetch hit a 429? Used by the base class's
   * refresh-ok branch to decide whether to reset the poll interval
   * back to the default cadence. */
  hadRateLimit(): boolean {
    return this.consecutiveRateLimits > 0;
  }

  /** Reset all counters + kickstart on a successful fetch. */
  recordSuccess(): void {
    this.deps.kickstart.clearStrikes();
    if (this.consecutiveRateLimits > 0) {
      this.deps.setPollInterval(POLL_INTERVAL_MS);
    }
    this.consecutiveRateLimits = 0;
    this.consecutiveErrors = 0;
    this.consecutiveColdStartAbsorbs = 0;
    this.deps.kickstart.reset();
  }

  handleFetchError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = error instanceof HttpError ? error.statusCode : null;

    if (statusCode === 429) {
      this.handle429(error);
      return;
    }

    this.consecutiveErrors++;
    // Network-class errors (DNS failure, TCP reset, timeout) absorb
    // a single attempt for the "still trying" spinner UX, then flip
    // to the offline skin on the second hit at the shorter network-
    // retry cadence so total spin time stays in the 30-40s range
    // instead of stretching to 3 * POLL_INTERVAL_MS (~6 minutes).
    // HTTP-class errors (5xx, transient blips) keep the original
    // 3-attempt absorption because they often resolve next poll.
    const isNetworkLevelError = statusCode === null && isNetworkError(message);
    const threshold = isNetworkLevelError
      ? NETWORK_ERROR_ABSORPTION_THRESHOLD
      : ERROR_ABSORPTION_THRESHOLD;
    if (this.consecutiveErrors < threshold) {
      const status = this.deps.getCurrentState().status;
      if (status === "ok" || status === "loading") {
        if (isNetworkLevelError) {
          this.deps.setPollInterval(NETWORK_ERROR_RETRY_MS);
        }
        return;
      }
    }

    let newState: ServiceState<unknown>;
    let reason: TransitionReason;
    if (statusCode && AUTH_ERROR_CODES.has(statusCode)) {
      newState = {
        status: "token-expired",
        message: `Authentication failed (${statusCode})`,
      };
      reason = "fetch-auth-error";
    } else if (isNetworkError(message)) {
      newState = { status: "offline", message };
      reason = "fetch-network-error";
    } else {
      newState = { status: "error", message };
      reason = "fetch-other-error";
    }
    this.deps.setState(newState, reason);
    if (isCacheableState(newState)) this.deps.writeCache(newState);
  }

  private handle429(error: unknown): void {
    this.consecutiveRateLimits++;
    this.consecutiveErrors = 0;

    if (this.deps.kickstart.consumeStrike()) {
      // Strikes remain - keep retrying at normal cadence.
      this.deps.setPollInterval(POLL_INTERVAL_MS);
      this.deps.setState({ status: "loading" }, "fetch-429-strike-retry");
      return;
    }

    // Cold-start absorption. If the 429 lands while we have ok
    // numbers on display AND the user is idle (= the park would be
    // tagged cold-start), keep showing the last good numbers for a
    // few polls instead of flipping to the "Idle" skin. Covers the
    // 5h billing-window rollover, brief idle gaps, and other
    // transient cold-poll 429s. Falls through to the full park if
    // the cold-start persists past COLD_START_ABSORPTION_THRESHOLD.
    const nowForAbsorb = Date.now();
    if (
      this.deps.getCurrentState().status === "ok" &&
      this.deps.kickstart.isIdleAt(nowForAbsorb) &&
      this.consecutiveColdStartAbsorbs < COLD_START_ABSORPTION_THRESHOLD
    ) {
      this.consecutiveColdStartAbsorbs++;
      // Keep polling at normal cadence so a fresh activity kickstart
      // picks up quickly. Do not touch state - widget continues to
      // render the prior ok numbers.
      this.deps.setPollInterval(POLL_INTERVAL_MS);
      this.deps.transitionLogger.recordAbsorbedRateLimit({
        serverMessage: extractServerMessage(error),
        snapshot: this.deps.buildSnapshot(),
      });
      return;
    }

    const rawRetryAfterMs =
      error instanceof HttpError && error.retryAfterMs
        ? error.retryAfterMs
        : RATE_LIMIT_BACKOFF_MS;
    const retryAfterMs = Math.min(rawRetryAfterMs, RATE_LIMIT_BACKOFF_MS);
    const now = Date.now();
    const isColdStart = this.deps.kickstart.isIdleAt(now);
    // Cold-start 429s are the usage endpoint declining to answer
    // polls on idle accounts - they recover as soon as the user
    // fires any prompt, so the server's retry-after is not a load-
    // bearing backoff signal in that case. Keep the cadence at
    // POLL_INTERVAL_MS for cold-start parks so recovery lands
    // within ~122s of activity returning, instead of stretching
    // to retryAfterMs (~15min). Real (non-cold-start) 429s stretch
    // because retry-after is the server's actual throttle ask.
    if (this.consecutiveRateLimits === 1 && !isColdStart) {
      this.deps.setPollInterval(retryAfterMs);
    }
    const newState: ServiceState<unknown> = {
      status: "rate-limited",
      retryAfterMs,
      rateLimitedAt: now,
      serverMessage: extractServerMessage(error),
      isColdStart,
    };
    this.deps.setState(newState, "fetch-429-parked");
    this.deps.writeCache(newState);
    this.deps.startCountdown();
  }
}
