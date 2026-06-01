import { existsSync } from "node:fs";
import type { ServiceState, StateListener } from "../../engine/serviceTypes";
import { Coordinator } from "../cacheCoordinator";
import { CACHE_FRESHNESS_OK_MS, CLAIM_TTL_MS, POLL_INTERVAL_MS } from "./constants";
import { CountdownTicker } from "./countdownTicker";
import { DiscoveryPoller } from "./discovery";
import { parseRetryAfterMs } from "./errorClassification";
import { httpGetJson } from "./httpClient";
import { HttpError } from "./httpError";
import { KickstartGate } from "./kickstartGate";
import { computeStartupDelay } from "./startupDelay";
import { resolveStateFreshness, statesEqual } from "./stateMachine";
import type { TransitionReason, TransitionStatus } from "./transitionLog";
import { UsageServiceErrorState } from "./usageServiceErrorState";
import { startRecoveryWatchdog, type RecoveryWatchdog } from "./usageServiceRecoveryWatchdog";
import { TransitionLogger, type TransitionSnapshot } from "./usageServiceTransitionLogger";

const NO_CACHE_RETRY_MS = 10_000;

export interface UsageServiceConfig {
  authDir: string;
  cacheFile: string;
  claimFile: string;
  endpointUrl: string;
  /** Provider tag on every transition record so the health command
   * can attribute entries when Claude and Codex are both active. */
  providerKey: "claude" | "codex";
  /** Per-workspace JSONL transition log path. Each subclass passes
   * a path inside `clientStateDir()`. */
  transitionLogPath: string;
}

/**
 * Shared state machine for usage polling services. Owns discovery,
 * startup delay, cache-first refresh, claim coordination, rate-limit
 * parking, activity-driven kickstart, dispose cleanup. Provider-
 * specific `getAuth()` and `validateResponse()` are abstract.
 *
 * Sibling helpers composed at construction:
 *   - usageServiceTransitionLogger: per-window transition log writer
 *   - usageServiceErrorState: fetch-error decision tree + counters
 *   - usageServiceRecoveryWatchdog: forces a fetch on the 15-min gap
 */
export abstract class UsageServiceBase<TResponse> {
  private state: ServiceState<TResponse>;
  private listeners = new Set<StateListener<ServiceState<TResponse>>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private recoveryWatchdog: RecoveryWatchdog | null = null;
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private discoveryPoller: DiscoveryPoller | null = null;
  private abortController: AbortController | null = null;
  private inFlight = false;
  private disposed = false;
  /** Last real HTTPS attempt time. Updated only in `doFetch`, never
   * on cache adoption, so the recovery watchdog measures genuine
   * network activity. Seeded so the watchdog does not fire at boot. */
  private lastFetchAttemptMs = Date.now();
  /** Active poll cadence in ms. Stamped onto transition records so a
   * reader can tell the normal cadence apart from a rate-limit
   * backoff stretch. */
  private currentPollIntervalMs = POLL_INTERVAL_MS;

  private readonly kickstart = new KickstartGate();
  private readonly coordinator: Coordinator<ServiceState<TResponse>>;
  private readonly countdown: CountdownTicker;
  private readonly transitionLogger: TransitionLogger;
  private readonly errorState: UsageServiceErrorState;

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

    this.transitionLogger = new TransitionLogger(
      config.transitionLogPath,
      config.providerKey
    );

    this.errorState = new UsageServiceErrorState({
      getCurrentState: () => this.state,
      setState: (s, r) => this.setState(s as ServiceState<TResponse>, r),
      setPollInterval: (ms) => this.setPollInterval(ms),
      writeCache: (s) =>
        this.coordinator.writeCache(s as ServiceState<TResponse>),
      startCountdown: () => this.countdown.start(),
      kickstart: this.kickstart,
      transitionLogger: this.transitionLogger,
      buildSnapshot: () => this.buildTransitionSnapshot(),
    });

    this.countdown = new CountdownTicker(
      () => this.onCountdownTick(),
      () => this.state.status === "rate-limited"
    );
  }

  /** 60s callback during rate-limited state. Lets kickstart fire
   * within a minute of activity returning instead of waiting out
   * the full retryAfterMs (up to 901s) for the next refresh(). */
  private onCountdownTick(): void {
    if (
      this.state.status === "rate-limited" &&
      this.kickstart.shouldKickstart(Date.now(), this.state.rateLimitedAt)
    ) {
      this.wake();
      void this.refresh();
      return;
    }
    for (const listener of this.listeners) listener(this.state);
  }

  protected abstract getAuth(): {
    token: string;
    headers: Record<string, string>;
  } | null;

  protected abstract validateResponse(data: unknown): data is TResponse;

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

  getState(): ServiceState<TResponse> {
    return this.state;
  }

  /** Diagnostic snapshot for the health command. */
  getDiagnostics(): import("../../engine/contracts").UsageServiceDiagnostics {
    const kick = this.kickstart.getDiagnostics();
    const rl = this.state.status === "rate-limited" ? this.state : null;
    return {
      consecutiveFailedKickstarts: kick.consecutiveFailedKickstarts,
      postWakeStrikesRemaining: kick.postWakeStrikesRemaining,
      rateLimitedAt: rl?.rateLimitedAt ?? null,
      retryAfterMs: rl?.retryAfterMs ?? null,
      consecutiveColdStartAbsorbs: this.errorState.getColdStartAbsorbs(),
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
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.recoveryWatchdog?.dispose();
    this.recoveryWatchdog = null;
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
    // Recovery watchdog runs alongside the poll loop so the
    // discovery-recovered path (auth dir appeared post-startup)
    // also gets the 15-min ceiling. Idempotent.
    this.recoveryWatchdog?.dispose();
    this.recoveryWatchdog = startRecoveryWatchdog({
      getCurrentStatus: () => this.state.status as TransitionStatus,
      getLastFetchAttemptMs: () => this.lastFetchAttemptMs,
      isDisposed: () => this.disposed,
      isInFlight: () => this.inFlight,
      forceRefresh: () => void this.refresh(true),
      buildSnapshot: () => this.buildTransitionSnapshot(),
      transitionLogger: this.transitionLogger,
    });
  }

  /** Unified state setter. Optional `cacheAgeMs` stamps the transition
   * with cache-adoption age so a reader can distinguish cross-window
   * adoption from this window's own near-expiring re-read. */
  private setState(
    state: ServiceState<TResponse>,
    reason: TransitionReason | null = null,
    cacheAgeMs?: number
  ): void {
    if (this.disposed || statesEqual(this.state, state)) return;
    const prev = this.state;
    this.state = state;
    for (const listener of this.listeners) listener(state);
    if (reason === null || prev.status === state.status) return;
    this.transitionLogger.recordTransition({
      from: prev.status as TransitionStatus,
      to: state.status as TransitionStatus,
      reason,
      nextState: state,
      snapshot: this.buildTransitionSnapshot(),
      cacheAgeMs,
    });
  }

  private buildTransitionSnapshot(): TransitionSnapshot {
    const activityMs = this.kickstart.getCurrentActivityMs();
    return {
      kickstartDiagnostics: this.kickstart.getDiagnostics(),
      consecutiveColdStartAbsorbs: this.errorState.getColdStartAbsorbs(),
      idleForMs:
        activityMs === null ? null : Math.max(0, Date.now() - activityMs),
      pollIntervalMs: this.currentPollIntervalMs,
    };
  }

  private setPollInterval(ms: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), ms);
    this.currentPollIntervalMs = ms;
  }

  private async refresh(force: boolean = false): Promise<void> {
    if (this.disposed || this.inFlight) return;

    if (!existsSync(this.config.authDir)) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.countdown.stop();
      this.setState({ status: "not-connected" }, "auth-dir-vanished");
      this.startDiscovery();
      return;
    }

    if (
      this.state.status === "rate-limited" &&
      this.kickstart.shouldKickstart(Date.now(), this.state.rateLimitedAt)
    ) {
      this.wake();
    }

    if (!force && this.tryAdoptFreshCache()) return;
    if (!this.tryClaimOrFallback()) return;

    const auth = this.getAuth();
    if (!auth) {
      const ns: ServiceState<TResponse> = { status: "no-auth" };
      if (this.state.status !== "no-auth") this.setState(ns, "auth-missing");
      this.coordinator.writeCache(ns);
      this.coordinator.releaseClaim();
      return;
    }

    this.inFlight = true;
    // lastFetchAttemptMs marks real HTTPS activity so the recovery
    // watchdog ignores poll-loop ticks that exited early.
    this.lastFetchAttemptMs = Date.now();
    this.transitionLogger.recordHeartbeat({
      status: this.state.status as TransitionStatus,
      reason: "fetch-attempted",
      snapshot: this.buildTransitionSnapshot(),
    });
    try {
      const usage = await this.doFetch(auth);
      if (!this.validateResponse(usage)) {
        this.setState(
          { status: "error", message: "Unexpected API response format" },
          "fetch-other-error"
        );
        return;
      }
      const okState: ServiceState<TResponse> = {
        status: "ok",
        data: usage,
        fetchedAt: Date.now(),
      };
      this.setState(okState, "fetch-ok");
      this.coordinator.writeCache(okState);
      this.countdown.stop();
      this.errorState.recordSuccess();
    } catch (error: unknown) {
      this.errorState.handleFetchError(error);
    } finally {
      this.inFlight = false;
      this.coordinator.releaseClaim();
    }
  }

  /** Adopt a cross-window fresh cache without an HTTPS call.
   * Returns true when adopted (caller short-circuits). Recovery
   * watchdog forces bypass this via force=true upstream. */
  private tryAdoptFreshCache(): boolean {
    const cache = this.coordinator.readCache();
    if (!cache || !this.coordinator.isFresh(cache)) return false;
    const cacheAgeMs = Date.now() - cache.timestamp;
    this.setState(cache.state, "cache-adopted", cacheAgeMs);
    if (cache.state.status === "rate-limited") {
      this.countdown.start();
    } else {
      this.countdown.stop();
    }
    return true;
  }

  /** Claim the shared cache lock; on contention, adopt the
   * existing cache or schedule a retry. Returns true when the
   * claim succeeded (caller may proceed). */
  private tryClaimOrFallback(): boolean {
    if (this.coordinator.tryClaim()) return true;
    const fallbackCache = this.coordinator.readCache();
    if (fallbackCache) {
      const cacheAgeMs = Date.now() - fallbackCache.timestamp;
      this.setState(fallbackCache.state, "cache-adopted", cacheAgeMs);
    } else {
      const handle = setTimeout(() => {
        this.pendingTimers.delete(handle);
        if (this.disposed) return;
        this.refresh();
      }, NO_CACHE_RETRY_MS);
      this.pendingTimers.add(handle);
    }
    return false;
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
        const ra = responseHeaders["retry-after"];
        const raValue = Array.isArray(ra) ? ra[0] : ra;
        return new HttpError(statusCode, body, parseRetryAfterMs(raValue));
      },
    });
  }
}
