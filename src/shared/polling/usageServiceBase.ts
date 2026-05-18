import { existsSync } from "node:fs";

import type { ServiceState, StateListener } from "../../engine/serviceTypes";
import { Coordinator } from "../cacheCoordinator";
import {
  AUTH_ERROR_CODES,
  CACHE_FRESHNESS_OK_MS,
  CLAIM_TTL_MS,
  COLD_START_ABSORPTION_THRESHOLD,
  ERROR_ABSORPTION_THRESHOLD,
  NETWORK_ERROR_ABSORPTION_THRESHOLD,
  NETWORK_ERROR_RETRY_MS,
  POLL_INTERVAL_MS,
  RATE_LIMIT_BACKOFF_MS,
} from "./constants";
import { CountdownTicker } from "./countdownTicker";
import { DiscoveryPoller } from "./discovery";
import {
  extractServerMessage,
  isNetworkError,
  parseRetryAfterMs,
} from "./errorClassification";
import { httpGetJson } from "./httpClient";
import { HttpError } from "./httpError";
import {
  isCacheableState,
  resolveStateFreshness,
  statesEqual,
} from "./stateMachine";
import { KickstartGate } from "./kickstartGate";
import { computeStartupDelay } from "./startupDelay";
import {
  logTransition,
  type TransitionReason,
  type TransitionStatus,
} from "./transitionLog";

const NO_CACHE_RETRY_MS = 10_000;

export interface UsageServiceConfig {
  authDir: string;
  cacheFile: string;
  claimFile: string;
  endpointUrl: string;
  /** Provider tag stamped onto every transition log record. Lets the
   * health command attribute entries when both Claude and Codex are
   * active in the same workspace. */
  providerKey: "claude" | "codex";
  /** Path to the per-workspace JSONL log of state transitions. Each
   * subclass passes a path inside `clientStateDir()` so the log stays
   * scoped to the current VS Code window's view of the state machine. */
  transitionLogPath: string;
}

/**
 * Shared state machine for usage polling services. Owns the full
 * lifecycle: discovery, startup delay, cache-first refresh, claim
 * coordination, rate-limit parking with countdown, activity-driven
 * kickstart with progressive escalation, error absorption, and
 * dispose cleanup.
 *
 * Provider-specific logic is supplied by two abstract methods:
 *   - `getAuth()` reads credentials and returns request headers
 *   - `validateResponse()` checks the API response shape
 *
 * The response type `TResponse` is the provider's raw API payload
 * (e.g. `UsageResponse` for Claude, `CodexUsageResponse` for Codex).
 */
export abstract class UsageServiceBase<TResponse> {
  private state: ServiceState<TResponse>;
  private listeners = new Set<StateListener<ServiceState<TResponse>>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private discoveryPoller: DiscoveryPoller | null = null;
  private abortController: AbortController | null = null;
  private inFlight = false;
  private disposed = false;
  private consecutiveRateLimits = 0;
  private consecutiveErrors = 0;
  /** Transient 429s tagged cold-start that we have absorbed while an
   * ok state is on display. Anthropic's usage endpoint cold-polls 429
   * on brief idle gaps (most visibly at the 5h billing-window rollover),
   * and flipping the widget straight to the "Idle" skin violates the
   * last-known-good principle - the user just had valid numbers a
   * minute ago. Instead, we keep rendering the prior ok state for a
   * few more polls, then fall through to the full rate-limited park
   * if the cold-start persists. Counter resets on any successful
   * fetch. */
  private consecutiveColdStartAbsorbs = 0;
  /** Most recently chosen poll cadence in ms. Mirrors whatever
   * `setPollInterval()` last set. Stamped onto transition log records
   * so a reader can tell at a glance whether the service is on the
   * normal 122s cadence or stretched to a rate-limit backoff. */
  private currentPollIntervalMs = POLL_INTERVAL_MS;

  private readonly kickstart = new KickstartGate();
  private readonly coordinator: Coordinator<ServiceState<TResponse>>;
  private readonly countdown: CountdownTicker;

  constructor(private readonly config: UsageServiceConfig) {
    this.state = existsSync(config.authDir)
      ? { status: "loading" }
      : { status: "not-connected" };

    this.coordinator = new Coordinator<ServiceState<TResponse>>(
      config.cacheFile,
      config.claimFile,
      CACHE_FRESHNESS_OK_MS,
      CLAIM_TTL_MS,
      undefined,
      resolveStateFreshness
    );

    this.countdown = new CountdownTicker(
      () => {
        // Check kickstart on every countdown tick (60s) so the
        // activity-driven recovery path is not gated on the extended
        // rate-limited poll interval. Without this, kickstart can only
        // fire inside refresh(), which runs at retryAfterMs (up to
        // 901s). The countdown tick is the perfect hook: it only runs
        // during rate-limited state and is already on a 60s cadence.
        if (this.state.status === "rate-limited" && this.kickstart.shouldKickstart(Date.now(), this.state.rateLimitedAt)) {
          this.wake();
          void this.refresh();
          return;
        }
        for (const listener of this.listeners) listener(this.state);
      },
      () => this.state.status === "rate-limited"
    );
  }

  protected abstract getAuth(): {
    token: string;
    headers: Record<string, string>;
  } | null;

  protected abstract validateResponse(
    data: unknown
  ): data is TResponse;

  start(): void {
    if (!existsSync(this.config.authDir)) {
      this.setState({ status: "not-connected" });
      this.startDiscovery();
      return;
    }

    const cache = this.coordinator.readCacheFresh();
    if (cache) this.setState(cache.state);

    this.startPolling();
  }

  subscribe(listener: StateListener<ServiceState<TResponse>>): void {
    this.listeners.add(listener);
    listener(this.state);
  }

  unsubscribe(listener: StateListener<ServiceState<TResponse>>): void {
    this.listeners.delete(listener);
  }

  rebroadcast(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  /** Current state snapshot. Used by the health command. */
  getState(): ServiceState<TResponse> {
    return this.state;
  }

  /** Diagnostic snapshot for the health command. Display only. */
  getDiagnostics(): import("../../engine/contracts").UsageServiceDiagnostics {
    const kick = this.kickstart.getDiagnostics();
    const rateLimitedState = this.state.status === "rate-limited" ? this.state : null;
    return {
      consecutiveFailedKickstarts: kick.consecutiveFailedKickstarts,
      postWakeStrikesRemaining: kick.postWakeStrikesRemaining,
      rateLimitedAt: rateLimitedState?.rateLimitedAt ?? null,
      retryAfterMs: rateLimitedState?.retryAfterMs ?? null,
      consecutiveColdStartAbsorbs: this.consecutiveColdStartAbsorbs,
    };
  }

  setActivityProbe(probe: () => number | null): void {
    this.kickstart.setActivityProbe(probe);
  }

  resetKickstartEscalation(): void {
    if (this.disposed) return;
    this.kickstart.reset();
    if (this.state.status === "rate-limited") {
      this.setPollInterval(POLL_INTERVAL_MS);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const handle of this.pendingTimers) clearTimeout(handle);
    this.pendingTimers.clear();
    this.discoveryPoller?.dispose();
    this.discoveryPoller = null;
    this.countdown.stop();
    this.abortController?.abort();
    this.listeners.clear();
  }

  private wake(): void {
    if (this.disposed) return;
    if (this.state.status !== "rate-limited") return;
    this.consecutiveRateLimits = 0;
    this.kickstart.onWake();
    this.countdown.stop();
    this.setState({ status: "loading" }, "wake-from-park");
    this.setPollInterval(POLL_INTERVAL_MS);
  }

  private startDiscovery(): void {
    this.discoveryPoller?.dispose();
    this.discoveryPoller = new DiscoveryPoller(this.config.authDir, () => {
      this.setState({ status: "loading" }, "discovery-recovered");
      this.startPolling();
    });
    this.discoveryPoller.start();
  }

  private startPolling(): void {
    this.discoveryPoller?.stop();
    const delay = computeStartupDelay(this.coordinator);
    const handle = setTimeout(() => {
      this.pendingTimers.delete(handle);
      if (this.disposed) return;
      this.refresh();
      this.timer = setInterval(() => this.refresh(), POLL_INTERVAL_MS);
    }, delay);
    this.pendingTimers.add(handle);
  }

  private setState(
    state: ServiceState<TResponse>,
    reason: TransitionReason | null = null
  ): void {
    if (this.disposed) return;
    if (statesEqual(this.state, state)) return;
    const prev = this.state;
    this.state = state;
    for (const listener of this.listeners) listener(state);
    if (reason !== null && prev.status !== state.status) {
      this.writeTransition(
        prev.status as TransitionStatus,
        state.status as TransitionStatus,
        reason,
        state
      );
    }
  }

  private writeTransition(
    from: TransitionStatus,
    to: TransitionStatus,
    reason: TransitionReason,
    nextState: ServiceState<TResponse>
  ): void {
    const kick = this.kickstart.getDiagnostics();
    const isRateLimited = nextState.status === "rate-limited";
    logTransition(this.config.transitionLogPath, {
      at: Date.now(),
      provider: this.config.providerKey,
      from,
      to,
      reason,
      isColdStart: isRateLimited ? nextState.isColdStart : undefined,
      consecutiveColdStartAbsorbs: this.consecutiveColdStartAbsorbs,
      consecutiveFailedKickstarts: kick.consecutiveFailedKickstarts,
      retryAfterMs: isRateLimited ? nextState.retryAfterMs : undefined,
      serverMessage: isRateLimited ? nextState.serverMessage : undefined,
      idleForMs: this.computeIdleForMs(),
      pollIntervalMs: this.currentPollIntervalMs,
    });
  }

  /** Wall-clock ms since the last transcript-write activity, or null
   * when no session is resolved yet. Source for the `idleForMs` field
   * stamped on every transition record. */
  private computeIdleForMs(): number | null {
    const activityMs = this.kickstart.getCurrentActivityMs();
    if (activityMs === null) return null;
    return Math.max(0, Date.now() - activityMs);
  }

  /** Cache-adoption setState that stamps `cacheAgeMs` onto the
   * transition record. Helps distinguish "this window adopted a fresh
   * cross-window cache another window just wrote" from "this window
   * read its own near-expiring cache and skipped the API call." */
  private setStateWithCacheAge(
    state: ServiceState<TResponse>,
    reason: TransitionReason,
    cacheAgeMs: number
  ): void {
    if (this.disposed) return;
    if (statesEqual(this.state, state)) return;
    const prev = this.state;
    this.state = state;
    for (const listener of this.listeners) listener(state);
    if (prev.status === state.status) return;
    const kick = this.kickstart.getDiagnostics();
    const isRateLimited = state.status === "rate-limited";
    logTransition(this.config.transitionLogPath, {
      at: Date.now(),
      provider: this.config.providerKey,
      from: prev.status as TransitionStatus,
      to: state.status as TransitionStatus,
      reason,
      isColdStart: isRateLimited ? state.isColdStart : undefined,
      consecutiveColdStartAbsorbs: this.consecutiveColdStartAbsorbs,
      consecutiveFailedKickstarts: kick.consecutiveFailedKickstarts,
      retryAfterMs: isRateLimited ? state.retryAfterMs : undefined,
      serverMessage: isRateLimited ? state.serverMessage : undefined,
      idleForMs: this.computeIdleForMs(),
      pollIntervalMs: this.currentPollIntervalMs,
      cacheAgeMs,
    });
  }

  /** Log a transition-shaped event whose `from` and `to` are the same
   * status (the state machine did not move). Used for fetch-attempted
   * heartbeats and kickstart-skipped notes that capture polling
   * activity even when state stays put. */
  private logEvent(reason: TransitionReason, status: TransitionStatus): void {
    const kick = this.kickstart.getDiagnostics();
    logTransition(this.config.transitionLogPath, {
      at: Date.now(),
      provider: this.config.providerKey,
      from: status,
      to: status,
      reason,
      consecutiveColdStartAbsorbs: this.consecutiveColdStartAbsorbs,
      consecutiveFailedKickstarts: kick.consecutiveFailedKickstarts,
      idleForMs: this.computeIdleForMs(),
      pollIntervalMs: this.currentPollIntervalMs,
    });
  }

  private setPollInterval(ms: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), ms);
    this.currentPollIntervalMs = ms;
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight) return;

    if (!existsSync(this.config.authDir)) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.countdown.stop();
      this.setState({ status: "not-connected" }, "auth-dir-vanished");
      this.startDiscovery();
      return;
    }

    if (this.state.status === "rate-limited" && this.kickstart.shouldKickstart(Date.now(), this.state.rateLimitedAt)) {
      this.wake();
    }

    const cache = this.coordinator.readCache();
    if (cache && this.coordinator.isFresh(cache)) {
      const cacheAgeMs = Date.now() - cache.timestamp;
      this.setStateWithCacheAge(cache.state, "cache-adopted", cacheAgeMs);
      if (cache.state.status === "ok") this.consecutiveErrors = 0;
      if (cache.state.status === "rate-limited") {
        this.countdown.start();
      } else {
        this.countdown.stop();
      }
      return;
    }

    if (!this.coordinator.tryClaim()) {
      if (cache) {
        const cacheAgeMs = Date.now() - cache.timestamp;
        this.setStateWithCacheAge(cache.state, "cache-adopted", cacheAgeMs);
      } else {
        const handle = setTimeout(() => {
          this.pendingTimers.delete(handle);
          if (this.disposed) return;
          this.refresh();
        }, NO_CACHE_RETRY_MS);
        this.pendingTimers.add(handle);
      }
      return;
    }

    const auth = this.getAuth();
    if (!auth) {
      const newState: ServiceState<TResponse> = { status: "no-auth" };
      if (this.state.status !== "no-auth") this.setState(newState, "auth-missing");
      this.coordinator.writeCache(newState);
      this.coordinator.releaseClaim();
      return;
    }

    this.inFlight = true;
    // Log every fetch attempt so the transition log shows poll cadence
    // even when nothing else changes. A long gap between fetch-attempted
    // records means the service is parked on a long backoff (or
    // disposed) - useful evidence when diagnosing "widget hasn't
    // refreshed in 20 minutes."
    this.logEvent("fetch-attempted", this.state.status as TransitionStatus);
    try {
      const usage = await this.doFetch(auth);

      if (!this.validateResponse(usage)) {
        this.setState(
          {
            status: "error",
            message: "Unexpected API response format",
          },
          "fetch-other-error"
        );
        return;
      }

      const newState: ServiceState<TResponse> = {
        status: "ok",
        data: usage,
        fetchedAt: Date.now(),
      };
      this.setState(newState, "fetch-ok");
      this.coordinator.writeCache(newState);
      this.countdown.stop();

      this.kickstart.clearStrikes();
      if (this.consecutiveRateLimits > 0) {
        this.setPollInterval(POLL_INTERVAL_MS);
      }
      this.consecutiveRateLimits = 0;
      this.consecutiveErrors = 0;
      this.consecutiveColdStartAbsorbs = 0;
      this.kickstart.reset();
    } catch (error: unknown) {
      this.handleFetchError(error);
    } finally {
      this.inFlight = false;
      this.coordinator.releaseClaim();
    }
  }

  private doFetch(auth: {
    token: string;
    headers: Record<string, string>;
  }): Promise<TResponse> {
    this.abortController = new AbortController();
    return httpGetJson<TResponse>({
      url: this.config.endpointUrl,
      headers: auth.headers,
      abortController: this.abortController,
      onNon200: (statusCode, body, responseHeaders) => {
        const retryAfterHeader = responseHeaders["retry-after"];
        const retryAfterValue = Array.isArray(retryAfterHeader)
          ? retryAfterHeader[0]
          : retryAfterHeader;
        return new HttpError(
          statusCode,
          body,
          parseRetryAfterMs(retryAfterValue)
        );
      },
    });
  }

  private handleFetchError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = error instanceof HttpError ? error.statusCode : null;

    if (statusCode === 429) {
      this.consecutiveRateLimits++;
      this.consecutiveErrors = 0;

      if (this.kickstart.consumeStrike()) {
        // Strikes remain - keep retrying at normal cadence.
        this.setPollInterval(POLL_INTERVAL_MS);
        this.setState({ status: "loading" }, "fetch-429-strike-retry");
        return;
      }

      // Cold-start absorption. If the 429 lands while we already have
      // ok numbers on display AND the user is idle (= the park would
      // be tagged cold-start), keep showing the last good numbers for
      // a few polls instead of flipping the widget to the "Idle" skin.
      // Covers the 5h billing-window rollover, brief idle gaps, and
      // other transient cold-poll 429s that resolve on the next tick.
      // Falls through to the full park if the cold-start persists
      // past COLD_START_ABSORPTION_THRESHOLD polls.
      const nowForAbsorb = Date.now();
      if (
        this.state.status === "ok" &&
        this.kickstart.isIdleAt(nowForAbsorb) &&
        this.consecutiveColdStartAbsorbs < COLD_START_ABSORPTION_THRESHOLD
      ) {
        this.consecutiveColdStartAbsorbs++;
        // Keep polling at normal cadence so a fresh activity kickstart
        // picks up quickly. Do not touch state - widget continues to
        // render the prior ok numbers from `this.state`.
        this.setPollInterval(POLL_INTERVAL_MS);
        // Record the absorbed 429 in the transition log even though
        // status didn't change. The absorb counter + idleForMs are the
        // load-bearing signals for "widget went idle randomly" debugging
        // - the user can see how many cold-poll 429s have stacked AND
        // whether the activity probe agreed they were idle at each one.
        logTransition(this.config.transitionLogPath, {
          at: nowForAbsorb,
          provider: this.config.providerKey,
          from: "ok",
          to: "ok",
          reason: "fetch-429-absorbed",
          consecutiveColdStartAbsorbs: this.consecutiveColdStartAbsorbs,
          consecutiveFailedKickstarts:
            this.kickstart.getDiagnostics().consecutiveFailedKickstarts,
          serverMessage: extractServerMessage(error),
          idleForMs: this.computeIdleForMs(),
          pollIntervalMs: this.currentPollIntervalMs,
        });
        return;
      }

      const rawRetryAfterMs =
        error instanceof HttpError && error.retryAfterMs
          ? error.retryAfterMs
          : RATE_LIMIT_BACKOFF_MS;
      const retryAfterMs = Math.min(rawRetryAfterMs, RATE_LIMIT_BACKOFF_MS);
      if (this.consecutiveRateLimits === 1) {
        this.setPollInterval(retryAfterMs);
      }
      const now = Date.now();
      // Anthropic's usage endpoint 429s cold polls on accounts with
      // no recent OAuth activity. Tag the park as cold-start when
      // the user is idle so the renderer shows a friendly "Idle"
      // skin instead of the alarm-level "Offline" skin. Once the
      // user activates a session and we re-park with fresh
      // activity, the new park is not cold and shows the real
      // Offline view.
      const newState: ServiceState<TResponse> = {
        status: "rate-limited",
        retryAfterMs,
        rateLimitedAt: now,
        serverMessage: extractServerMessage(error),
        isColdStart: this.kickstart.isIdleAt(now),
      };
      this.setState(newState, "fetch-429-parked");
      this.coordinator.writeCache(newState);
      this.countdown.start();
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
      if (this.state.status === "ok" || this.state.status === "loading") {
        if (isNetworkLevelError) {
          this.setPollInterval(NETWORK_ERROR_RETRY_MS);
        }
        return;
      }
    }

    let newState: ServiceState<TResponse>;
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
    this.setState(newState, reason);
    if (isCacheableState(newState)) this.coordinator.writeCache(newState);
  }
}
