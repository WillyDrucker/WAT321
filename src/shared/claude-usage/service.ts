import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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
import { isNetworkError } from "../polling/errorClassification";
import { httpGetJson } from "../polling/httpClient";
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
    const statusMatch = message.match(/^HTTP (\d+):/);
    const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : null;

    // Rate limits always surface immediately and get written to shared cache.
    if (statusCode === 429) {
      this.consecutiveRateLimits++;
      this.consecutiveErrors = 0;
      if (this.consecutiveRateLimits === 1) {
        this.setPollInterval(RATE_LIMIT_BACKOFF_MS);
      }
      const newState: ServiceState = {
        status: "rate-limited",
        retryAfterMs: RATE_LIMIT_BACKOFF_MS,
        rateLimitedAt: Date.now(),
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
    });
  }
}
