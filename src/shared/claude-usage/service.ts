import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Coordinator } from "../coordinator";
import {
  AUTH_ERROR_CODES,
  CACHE_FRESHNESS_OK_MS,
  CLAIM_TTL_MS,
  ERROR_ABSORPTION_THRESHOLD,
  POLL_INTERVAL_MS,
  RATE_LIMIT_BACKOFF_MS,
} from "../polling/constants";
import { CountdownTicker } from "../polling/countdownTicker";
import { DiscoveryPoller } from "../polling/discovery";
import {
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
const STAMP_DIR = join(homedir(), ".wat321");
const CACHE_FILE = join(STAMP_DIR, "claude-usage.cache.json");
const CLAIM_FILE = join(STAMP_DIR, "claude-usage.claim");
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
  private discoveryPoller: DiscoveryPoller | null = null;
  private abortController: AbortController | null = null;
  private inFlight = false;
  private disposed = false;
  private consecutiveRateLimits = 0;
  private consecutiveErrors = 0;
  /** Non-zero only after a user-initiated `wake()` out of the
   * 15-minute fallback. While > 0, a 429 response decrements this
   * counter and keeps polling at the normal cadence instead of
   * parking back in rate-limited. When it hits 0, we return to the
   * fallback state. Reset to 0 on any successful fetch or any
   * non-429 error path. */
  private postWakeStrikesRemaining = 0;

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

  /** Click-to-wake from the 15-minute fallback rate-limited state.
   * Only valid when currently parked in `rate-limited` with
   * `source === "fallback"` - we never override a server-directed
   * wait (`source === "server"`). Does NOT force an immediate
   * fetch: transitions state to `loading`, resets the poll interval
   * to the normal `POLL_INTERVAL_MS` cadence, and lets the next
   * poll fire on that schedule. Arms a 3-strike post-wake counter
   * so the next three 429s stay on normal cadence instead of
   * immediately snapping back to the 15-minute fallback. A
   * successful fetch during the wake window clears the counter
   * and restores normal operation. */
  wake(): void {
    if (this.disposed) return;
    if (this.state.status !== "rate-limited") return;
    if (this.state.source !== "fallback") return;
    this.consecutiveRateLimits = 0;
    this.postWakeStrikesRemaining = 3;
    this.countdown.stop();
    this.setState({ status: "loading" });
    this.setPollInterval(POLL_INTERVAL_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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
    setTimeout(() => {
      if (this.disposed) return;
      this.refresh();
      this.timer = setInterval(() => this.refresh(), POLL_INTERVAL_MS);
    }, delay);
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
        setTimeout(() => {
          if (this.disposed) return;
          this.refresh();
        }, NO_CACHE_RETRY_MS);
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
    } catch (error: unknown) {
      this.handleFetchError(error);
    } finally {
      this.inFlight = false;
      this.coordinator.releaseClaim();
    }
  }

  private handleFetchError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : (() => {
            const m = message.match(/^HTTP (\d+):/);
            return m ? parseInt(m[1], 10) : null;
          })();

    // Rate limits always surface immediately and get written to shared cache.
    // Honor the server's Retry-After header when present; otherwise fall
    // back to the hardcoded 15-minute window. No consecutive-429 cap and
    // no escape-hatch command - WAT321 stays passive and lets Anthropic's
    // server-sent Retry-After drive the cadence until the lockout clears
    // naturally. The one exception is the post-wake window: if the user
    // clicked the 15-minute fallback widget to wake it, we allow up to
    // 3 consecutive 429s at the normal poll cadence before returning to
    // the rate-limited state. This lets a user correct our conservative
    // guess without immediately snapping back to sleep on the first
    // transient 429.
    if (statusCode === 429) {
      this.consecutiveRateLimits++;
      this.consecutiveErrors = 0;

      // Post-wake probation: user clicked to exit the 15-min fallback,
      // so the next few 429s are absorbed rather than triggering an
      // immediate re-park. Keep polling at the normal cadence.
      if (this.postWakeStrikesRemaining > 0) {
        this.postWakeStrikesRemaining--;
        if (this.postWakeStrikesRemaining > 0) {
          this.setPollInterval(POLL_INTERVAL_MS);
          this.setState({ status: "loading" });
          return;
        }
        // Final strike exhausted - fall through to normal park
        // logic. The state below will show the 15-min fallback again
        // and the widget re-enables click-to-wake.
      }

      const retryAfterMs =
        error instanceof HttpError && error.retryAfterMs
          ? error.retryAfterMs
          : RATE_LIMIT_BACKOFF_MS;
      const source: "fallback" | "server" =
        error instanceof HttpError && error.retryAfterMs
          ? "server"
          : "fallback";
      if (this.consecutiveRateLimits === 1) {
        this.setPollInterval(retryAfterMs);
      }
      const newState: ServiceState = {
        status: "rate-limited",
        retryAfterMs,
        rateLimitedAt: Date.now(),
        source,
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
