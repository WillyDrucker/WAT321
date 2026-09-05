import type { ServiceState } from "../../engine/serviceTypes";
import type { TransitionReason, TransitionStatus } from "../../engine/usageTransitionLog";
import type { Coordinator } from "../cacheCoordinator";
import type { CountdownTicker } from "./countdownTicker";
import { parseRetryAfterMs } from "./errorClassification";
import { httpGetJson } from "./httpClient";
import { HttpError } from "./httpError";
import type { UsageServiceErrorState } from "./usageServiceErrorState";
import type { TransitionLogger, TransitionSnapshot } from "./usageServiceTransitionLogger";

/**
 * One refresh of a usage service, from cache adoption to the HTTPS
 * fetch. Adopt a fresh cross-window cache, else claim the shared fetch
 * lock, else adopt whatever cache exists or retry shortly. With the
 * claim held it fetches, validates, publishes the ok state, and hands
 * failures to `UsageServiceErrorState`. `UsageServiceBase` owns the
 * state and the timers and injects the setters, the same seam
 * `usageServiceErrorState.ts` uses.
 */

/** Retry cadence when the claim is held elsewhere and no cache exists
 * to adopt, so a fresh window is not stuck on `loading` for a whole
 * poll interval. */
const NO_CACHE_RETRY_MS = 10_000;

interface UsageAuth {
  token: string;
  headers: Record<string, string>;
}

interface FetchCycleDeps<TResponse> {
  endpointUrl: string;
  coordinator: Coordinator<ServiceState<TResponse>>;
  countdown: CountdownTicker;
  errorState: UsageServiceErrorState;
  transitionLogger: TransitionLogger;
  getState(): ServiceState<TResponse>;
  /** Same shape as the base class's setState. `cacheAgeMs` stamps a
   * cache adoption so a reader can distinguish cross-window adoption
   * from this window's own near-expiring re-read. */
  setState(state: ServiceState<TResponse>, reason: TransitionReason, cacheAgeMs?: number): void;
  buildSnapshot(): TransitionSnapshot;
  /** Retry the refresh through the base's tracked timers so dispose
   * clears it. */
  scheduleRetry(ms: number): void;
  getAuth(): UsageAuth | null;
  validateResponse(data: unknown): data is TResponse;
}

export class UsageFetchCycle<TResponse> {
  private abortController: AbortController | null = null;
  private inFlight = false;
  /** Last real HTTPS attempt time. Updated only when a request goes
   * out, never on cache adoption, so the recovery watchdog measures
   * genuine network activity. Seeded so the watchdog does not fire at
   * boot. */
  private lastFetchAttemptMs = Date.now();

  constructor(private readonly deps: FetchCycleDeps<TResponse>) {}

  isInFlight(): boolean {
    return this.inFlight;
  }

  getLastFetchAttemptMs(): number {
    return this.lastFetchAttemptMs;
  }

  abort(): void {
    this.abortController?.abort();
  }

  /** `force` skips fresh-cache adoption (the recovery watchdog's
   * bypass) but still honors the claim. */
  async run(force: boolean): Promise<void> {
    if (this.inFlight) return;
    const d = this.deps;
    if (!force && this.tryAdoptFreshCache()) return;
    if (!this.tryClaimOrFallback()) return;

    const auth = d.getAuth();
    if (!auth) {
      const ns: ServiceState<TResponse> = { status: "no-auth" };
      if (d.getState().status !== "no-auth") d.setState(ns, "auth-missing");
      d.coordinator.writeCache(ns);
      d.coordinator.releaseClaim();
      return;
    }

    this.inFlight = true;
    this.lastFetchAttemptMs = Date.now();
    d.transitionLogger.recordHeartbeat({
      status: d.getState().status as TransitionStatus,
      reason: "fetch-attempted",
      snapshot: d.buildSnapshot(),
    });
    try {
      const usage = await this.fetchJson(auth);
      if (!d.validateResponse(usage)) {
        d.setState(
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
      d.setState(okState, "fetch-ok");
      d.coordinator.writeCache(okState);
      d.countdown.stop();
      d.errorState.recordSuccess();
    } catch (error: unknown) {
      d.errorState.handleFetchError(error);
    } finally {
      this.inFlight = false;
      d.coordinator.releaseClaim();
    }
  }

  /** Adopt a cross-window fresh cache without an HTTPS call. Returns
   * true when adopted, and the caller short-circuits. */
  private tryAdoptFreshCache(): boolean {
    const d = this.deps;
    const cache = d.coordinator.readCache();
    if (!cache || !d.coordinator.isFresh(cache)) return false;
    d.setState(cache.state, "cache-adopted", Date.now() - cache.timestamp);
    if (cache.state.status === "rate-limited") {
      d.countdown.start();
    } else {
      d.countdown.stop();
    }
    return true;
  }

  /** Claim the shared cache lock. On contention, adopt the existing
   * cache or schedule a retry. Returns true when the claim succeeded
   * and the caller may fetch. */
  private tryClaimOrFallback(): boolean {
    const d = this.deps;
    if (d.coordinator.tryClaim()) return true;
    const fallbackCache = d.coordinator.readCache();
    if (fallbackCache) {
      d.setState(fallbackCache.state, "cache-adopted", Date.now() - fallbackCache.timestamp);
    } else {
      d.scheduleRetry(NO_CACHE_RETRY_MS);
    }
    return false;
  }

  private fetchJson(auth: UsageAuth): Promise<TResponse> {
    this.abortController = new AbortController();
    return httpGetJson<TResponse>({
      url: this.deps.endpointUrl,
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
