import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Coordinator } from "../coordinator";
import {
  AUTH_ERROR_CODES,
  CACHE_FRESHNESS_OK_MS,
  CLAIM_TTL_MS,
  ERROR_ABSORPTION_THRESHOLD,
  KICKSTART_ACTIVITY_WINDOW_MS,
  KICKSTART_ESCALATION_MS,
  POLL_INTERVAL_MS,
  RATE_LIMIT_BACKOFF_MS,
} from "../polling/constants";
import { CountdownTicker } from "../polling/countdownTicker";
import { DiscoveryPoller } from "../polling/discovery";
import {
  extractServerMessage,
  isNetworkError,
  parseRetryAfterMs,
} from "../polling/errorClassification";
import { httpGetJson } from "../polling/httpClient";
import { HttpError } from "../polling/httpError";
import {
  isCacheableState,
  resolveStateFreshness,
  statesEqual,
} from "../polling/stateMachine";
import { computeStartupDelay } from "../polling/startupDelay";
import type { ServiceState, UsageResponse } from "./types";

const AUTH_DIR = join(homedir(), ".claude");
const WAT321_DIR = join(homedir(), ".wat321");
const CACHE_FILE = join(WAT321_DIR, "claude-usage.cache.json");
const CLAIM_FILE = join(WAT321_DIR, "claude-usage.claim");
const CREDENTIALS_FILE = join(AUTH_DIR, ".credentials.json");
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const NO_CACHE_RETRY_MS = 10_000;

type Listener = (state: ServiceState) => void;

export class ClaudeUsageSharedService {
  /**
   * Initial state reflects auth-dir presence so the first subscriber sees
   * the correct state synchronously. Widgets that hide on "not-connected"
   * never flash their loading text on startup.
   */
  private state: ServiceState = existsSync(AUTH_DIR)
    ? { status: "loading" }
    : { status: "not-connected" };

  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Pending one-shot timers (startup delay + no-cache retry). Both
   * can legitimately be in flight when `dispose()` runs - e.g. the
   * provider is disabled before the startup delay fires, or between
   * a losing claim race and the 10-second retry. Tracking them as a
   * set lets `dispose()` cancel every pending tick synchronously so
   * disposed services never fire stale callbacks. */
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private discoveryPoller: DiscoveryPoller | null = null;
  private abortController: AbortController | null = null;
  private inFlight = false;
  private disposed = false;
  private consecutiveRateLimits = 0;
  private consecutiveErrors = 0;
  /** Non-zero only after an activity-driven `wake()` out of the
   * rate-limited park. While > 0, a 429 response decrements this
   * counter and keeps polling at the normal cadence instead of
   * immediately re-parking. When it hits 0, we return to rate-limited.
   * Reset to 0 on any successful fetch or non-429 error. */
  private postWakeStrikesRemaining = 0;
  /** Count of kickstart rounds that failed (all post-wake strikes
   * exhausted without a successful fetch) against the current
   * outage. Indexes into `KICKSTART_ESCALATION_MS` to pick the
   * minimum park time before the next kickstart is eligible, so
   * progressive friction is applied when the server keeps 429'ing
   * us. Resets to 0 on any successful fetch. */
  private consecutiveFailedKickstarts = 0;
  /** Optional callback returning the most recent active-transcript
   * mtime observed by the Claude session token service. Used to gate
   * the activity-driven kickstart out of `rate-limited`. Returns
   * `null` when no live session has been resolved yet. */
  private getActivityMs: (() => number | null) | null = null;

  private coordinator = new Coordinator<ServiceState>(
    CACHE_FILE,
    CLAIM_FILE,
    CACHE_FRESHNESS_OK_MS,
    CLAIM_TTL_MS,
    undefined,
    resolveStateFreshness
  );

  private countdown = new CountdownTicker(
    () => {
      for (const listener of this.listeners) listener(this.state);
    },
    () => this.state.status === "rate-limited"
  );

  start(): void {
    if (!existsSync(AUTH_DIR)) {
      this.setState({ status: "not-connected" });
      this.startDiscovery();
      return;
    }

    // Adopt cached state immediately on startup if available.
    const cache = this.coordinator.readCacheFresh();
    if (cache) this.setState(cache.state);

    this.startPolling();
  }

  subscribe(listener: Listener): void {
    this.listeners.add(listener);
    listener(this.state);
  }

  unsubscribe(listener: Listener): void {
    this.listeners.delete(listener);
  }

  /** Re-emit current state to all listeners without making API calls. */
  rebroadcast(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  /** Inject an activity callback that returns the most recent active-
   * transcript mtime from the Claude session token service. Wired in
   * `bootstrap.ts` after both services are constructed. Safe to call
   * before or after `start()`. */
  setActivityProbe(probe: () => number | null): void {
    this.getActivityMs = probe;
  }

  /** Manual user-driven recovery lever. Called from the Reset WAT321
   * command to clear the kickstart escalation ladder so a user
   * trapped in a sustained outage can get back to the responsive
   * fresh-park cadence without waiting for the natural success path
   * to reset the counter. Gating is preserved - this does NOT force
   * an immediate fetch and does NOT skip `shouldKickstart`. It only
   * zeroes the counter and, if we are currently parked on a long
   * interval from a 429, shrinks the interval back to the normal
   * poll cadence so the next gate check fires within ~2 min instead
   * of up to 15 min away. If there is no active Claude session when
   * that check runs, nothing will fire and the widget stays parked. */
  resetKickstartEscalation(): void {
    if (this.disposed) return;
    this.consecutiveFailedKickstarts = 0;
    if (this.state.status === "rate-limited") {
      this.setPollInterval(POLL_INTERVAL_MS);
    }
  }

  /** Activity-driven wake out of the rate-limited park. Transitions
   * state to `loading`, resets the poll interval to the normal cadence,
   * and arms a 3-strike post-wake counter so the next few 429s stay
   * on the normal cadence instead of immediately snapping back to the
   * rate-limited park. A successful fetch clears the counter. */
  private wake(): void {
    if (this.disposed) return;
    if (this.state.status !== "rate-limited") return;
    this.consecutiveRateLimits = 0;
    this.postWakeStrikesRemaining = 3;
    this.countdown.stop();
    this.setState({ status: "loading" });
    this.setPollInterval(POLL_INTERVAL_MS);
  }

  /** Returns true if we are parked in `rate-limited`, the park has
   * lasted at least the current escalation step's minimum, and the
   * active Claude transcript was written within the activity window.
   * Minimum park time escalates via `KICKSTART_ESCALATION_MS` based
   * on `consecutiveFailedKickstarts` so a sustained outage
   * progressively relaxes kickstart cadence instead of hammering
   * the server once every ~21 minutes forever. */
  private shouldKickstart(now: number): boolean {
    if (this.state.status !== "rate-limited") return false;
    const step = Math.min(
      this.consecutiveFailedKickstarts,
      KICKSTART_ESCALATION_MS.length - 1
    );
    const minPark = KICKSTART_ESCALATION_MS[step];
    if (now - this.state.rateLimitedAt < minPark) return false;
    const activityMs = this.getActivityMs?.() ?? null;
    if (activityMs === null) return false;
    return now - activityMs <= KICKSTART_ACTIVITY_WINDOW_MS;
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

  private startDiscovery(): void {
    this.discoveryPoller?.dispose();
    this.discoveryPoller = new DiscoveryPoller(AUTH_DIR, () => {
      this.setState({ status: "loading" });
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

  private setState(state: ServiceState): void {
    if (this.disposed) return;
    if (statesEqual(this.state, state)) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private setPollInterval(ms: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), ms);
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight) return;

    // If the auth directory was deleted mid-session, transition back
    // to discovery mode so a re-install picks up without manual reset.
    if (!existsSync(AUTH_DIR)) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.countdown.stop();
      this.setState({ status: "not-connected" });
      this.startDiscovery();
      return;
    }

    // Activity-driven kickstart: if we are parked in rate-limited and
    // the Claude session token service is reporting fresh transcript
    // activity, fall through to a real fetch. Live activity is
    // ground-truth evidence the API is serving the user right now,
    // so any lockout we are sitting on is stale by definition.
    if (this.shouldKickstart(Date.now())) {
      this.wake();
    }

    // Cache-first: read shared cache. If fresh, use it and skip API.
    const cache = this.coordinator.readCache();
    if (cache && this.coordinator.isFresh(cache)) {
      this.setState(cache.state);
      if (cache.state.status === "ok") this.consecutiveErrors = 0;
      if (cache.state.status === "rate-limited") {
        this.countdown.start();
      } else {
        this.countdown.stop();
      }
      return;
    }

    // Cache stale or missing - try to claim the refresh slot.
    if (!this.coordinator.tryClaim()) {
      if (cache) {
        // Show slightly stale cache rather than flickering to loading.
        this.setState(cache.state);
      } else {
        // No cache yet - schedule a quick retry to pick up the other
        // instance's result once it writes (claim TTL is 30s max).
        const handle = setTimeout(() => {
          this.pendingTimers.delete(handle);
          if (this.disposed) return;
          this.refresh();
        }, NO_CACHE_RETRY_MS);
        this.pendingTimers.add(handle);
      }
      return;
    }

    // We own the claim - actually fetch.
    const token = this.getAccessToken();
    if (!token) {
      const newState: ServiceState = { status: "no-auth" };
      if (this.state.status !== "no-auth") this.setState(newState);
      this.coordinator.writeCache(newState);
      this.coordinator.releaseClaim();
      return;
    }

    this.inFlight = true;
    try {
      const usage = await this.fetchUsage(token);

      if (!this.validateResponse(usage)) {
        this.setState({
          status: "error",
          message: "Unexpected API response format",
        });
        return;
      }

      const newState: ServiceState = {
        status: "ok",
        data: usage,
        fetchedAt: Date.now(),
      };
      this.setState(newState);
      this.coordinator.writeCache(newState);
      this.countdown.stop();

      this.postWakeStrikesRemaining = 0;
      if (this.consecutiveRateLimits > 0) {
        this.setPollInterval(POLL_INTERVAL_MS);
      }
      this.consecutiveRateLimits = 0;
      this.consecutiveErrors = 0;
      // Successful fetch clears the kickstart escalation ladder -
      // the outage is over, next park starts from the responsive
      // fresh-park step again.
      this.consecutiveFailedKickstarts = 0;
    } catch (error: unknown) {
      this.handleFetchError(error);
    } finally {
      this.inFlight = false;
      this.coordinator.releaseClaim();
    }
  }

  private handleFetchError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = error instanceof HttpError ? error.statusCode : null;

    // Rate limits surface immediately and get written to shared cache.
    // Server `Retry-After` is honored but capped at our own fallback so
    // an absurd value from a flailing edge during an outage cannot strand
    // the widget for longer than we would have waited anyway. The
    // post-wake probation absorbs the next few 429s after an
    // activity-driven kickstart so a single transient 429 immediately
    // after a kickstart does not snap us back to sleep.
    if (statusCode === 429) {
      this.consecutiveRateLimits++;
      this.consecutiveErrors = 0;

      if (this.postWakeStrikesRemaining > 0) {
        this.postWakeStrikesRemaining--;
        if (this.postWakeStrikesRemaining > 0) {
          this.setPollInterval(POLL_INTERVAL_MS);
          this.setState({ status: "loading" });
          return;
        }
        // Final strike exhausted - the kickstart round failed.
        // Bump the escalation counter (clamped to the last step)
        // so the next eligible kickstart is pushed progressively
        // further out. Resets to 0 on any successful fetch.
        this.consecutiveFailedKickstarts = Math.min(
          this.consecutiveFailedKickstarts + 1,
          KICKSTART_ESCALATION_MS.length - 1
        );
      }

      const rawRetryAfterMs =
        error instanceof HttpError && error.retryAfterMs
          ? error.retryAfterMs
          : RATE_LIMIT_BACKOFF_MS;
      const retryAfterMs = Math.min(rawRetryAfterMs, RATE_LIMIT_BACKOFF_MS);
      if (this.consecutiveRateLimits === 1) {
        this.setPollInterval(retryAfterMs);
      }
      const newState: ServiceState = {
        status: "rate-limited",
        retryAfterMs,
        rateLimitedAt: Date.now(),
        serverMessage: extractServerMessage(error),
      };
      this.setState(newState);
      this.coordinator.writeCache(newState);
      this.countdown.start();
      return;
    }

    // Absorb transient errors silently. Only surface "offline" after
    // ERROR_ABSORPTION_THRESHOLD consecutive failures. Covers stale
    // keep-alive sockets after idle, brief network blips, and
    // server-side reset windows. On startup (loading), also absorb
    // to prevent a false "Offline" flash.
    this.consecutiveErrors++;
    if (this.consecutiveErrors < ERROR_ABSORPTION_THRESHOLD) {
      if (this.state.status === "ok" || this.state.status === "loading") return;
    }

    let newState: ServiceState;
    if (statusCode && AUTH_ERROR_CODES.has(statusCode)) {
      newState = {
        status: "token-expired",
        message: `Authentication failed (${statusCode})`,
      };
    } else if (isNetworkError(message)) {
      newState = { status: "offline", message };
    } else {
      newState = { status: "error", message };
    }
    this.setState(newState);
    if (isCacheableState(newState)) this.coordinator.writeCache(newState);
  }

  private validateResponse(data: unknown): data is UsageResponse {
    if (data === null || typeof data !== "object") return false;
    const obj = data as Record<string, unknown>;

    for (const key of ["five_hour", "seven_day"]) {
      const value = obj[key];
      if (value === null || value === undefined) continue;
      if (typeof value !== "object") return false;
      const bucket = value as Record<string, unknown>;
      if (typeof bucket.utilization !== "number") return false;
      if (typeof bucket.resets_at !== "string") return false;
    }

    return true;
  }

  private getAccessToken(): string | null {
    try {
      const creds = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8"));
      return creds?.claudeAiOauth?.accessToken ?? null;
    } catch {
      return null;
    }
  }

  private fetchUsage(token: string): Promise<UsageResponse> {
    this.abortController = new AbortController();
    return httpGetJson<UsageResponse>({
      url: USAGE_ENDPOINT,
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      abortController: this.abortController,
      onNon200: (statusCode, body, responseHeaders) => {
        // Parse Retry-After so the 429 handler can honor the server's
        // actual wait hint rather than falling back to the flat 15 min
        // constant. Same pattern as the Codex usage service.
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

}
