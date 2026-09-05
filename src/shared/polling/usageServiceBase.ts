import { existsSync } from "node:fs";
import type { UsageServiceDiagnostics } from "../../engine/contracts";
import type { ServiceState, StateListener } from "../../engine/serviceTypes";
import type { TransitionReason, TransitionStatus } from "../../engine/usageTransitionLog";
import { Coordinator } from "../cacheCoordinator";
import { CountdownTicker } from "./countdownTicker";
import { KickstartGate } from "./kickstartGate";
import { CACHE_FRESHNESS_OK_MS, CLAIM_TTL_MS, POLL_INTERVAL_MS } from "./pollingTimings";
import { computeStartupDelay } from "./startupDelay";
import { resolveStateFreshness, statesEqual } from "./stateMachine";
import { UsageServiceErrorState } from "./usageServiceErrorState";
import { UsageFetchCycle } from "./usageServiceFetchCycle";
import { UsagePollSchedule } from "./usageServicePollSchedule";
import { TransitionLogger, type TransitionSnapshot } from "./usageServiceTransitionLogger";

interface UsageServiceConfig {
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
 * Shared state machine for usage polling services. Owns the state,
 * the listeners, discovery hand-off, rate-limit parking, and the
 * activity-driven kickstart. Provider-specific `getAuth()` and
 * `validateResponse()` are abstract.
 *
 * Sibling helpers composed at construction:
 *   - usageServiceTransitionLogger: per-window transition log writer
 *   - usageServiceErrorState: fetch-error decision tree + counters
 *   - usageServiceFetchCycle: cache adoption, claim, fetch, validate
 *   - usageServicePollSchedule: every timer, including discovery and
 *     the recovery watchdog that forces a fetch on the 15-min gap
 */
export abstract class UsageServiceBase<TResponse> {
  private state: ServiceState<TResponse>;
  private listeners = new Set<StateListener<ServiceState<TResponse>>>();
  private disposed = false;

  private readonly kickstart = new KickstartGate();
  private readonly schedule = new UsagePollSchedule(() => void this.refresh());
  private readonly coordinator: Coordinator<ServiceState<TResponse>>;
  private readonly countdown: CountdownTicker;
  private readonly transitionLogger: TransitionLogger;
  private readonly errorState: UsageServiceErrorState;
  private readonly fetchCycle: UsageFetchCycle<TResponse>;

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
      setPollInterval: (ms) => this.schedule.setPollInterval(ms),
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

    this.fetchCycle = new UsageFetchCycle<TResponse>({
      endpointUrl: config.endpointUrl,
      coordinator: this.coordinator,
      countdown: this.countdown,
      errorState: this.errorState,
      transitionLogger: this.transitionLogger,
      getState: () => this.state,
      setState: (s, r, cacheAgeMs) => this.setState(s, r, cacheAgeMs),
      buildSnapshot: () => this.buildTransitionSnapshot(),
      scheduleRetry: (ms) => this.schedule.schedule(() => void this.refresh(), ms),
      getAuth: () => this.getAuth(),
      validateResponse: (data): data is TResponse => this.validateResponse(data),
    });
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
  getDiagnostics(): UsageServiceDiagnostics {
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
      this.schedule.setPollInterval(POLL_INTERVAL_MS);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.schedule.dispose();
    this.countdown.stop();
    this.fetchCycle.abort();
    this.listeners.clear();
  }

  private wake(): void {
    if (this.disposed) return;
    if (this.state.status !== "rate-limited") return;
    this.kickstart.onWake();
    this.countdown.stop();
    this.setState({ status: "loading" }, "wake-from-park");
    this.schedule.setPollInterval(POLL_INTERVAL_MS);
  }

  private startDiscovery(): void {
    this.schedule.startDiscovery(this.config.authDir, () => {
      this.setState({ status: "loading" }, "discovery-recovered");
      this.startPolling();
    });
  }

  private startPolling(): void {
    this.schedule.startPolling(computeStartupDelay(this.coordinator), {
      getCurrentStatus: () => this.state.status as TransitionStatus,
      getLastFetchAttemptMs: () => this.fetchCycle.getLastFetchAttemptMs(),
      isDisposed: () => this.disposed,
      isInFlight: () => this.fetchCycle.isInFlight(),
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
      pollIntervalMs: this.schedule.getPollIntervalMs(),
    };
  }

  private async refresh(force: boolean = false): Promise<void> {
    if (this.disposed || this.fetchCycle.isInFlight()) return;

    if (!existsSync(this.config.authDir)) {
      this.schedule.stopPolling();
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

    await this.fetchCycle.run(force);
  }
}
