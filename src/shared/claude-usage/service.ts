import { readFileSync, existsSync } from "fs";
import https from "https";
import { homedir } from "os";
import { join } from "path";
import type { ServiceState, UsageResponse } from "./types";
import { Coordinator } from "../coordinator";

const POLL_INTERVAL = 122_000;
const BACKOFF_INTERVAL = 901_000;
const COOLDOWN_MS = 61_000;
const CACHE_FRESHNESS_MS = 115_000; // slightly less than poll interval
// Auth/error states recover faster once the user fixes them, so we share
// them with a much shorter window. Long-lived success states stay cached
// for the full interval to avoid duplicate API calls across windows.
const ERROR_CACHE_FRESHNESS_MS = 30_000;
const CLAIM_TTL_MS = 30_000;
const REQUEST_TIMEOUT = 10_000;
const AUTH_ERROR_CODES = new Set([401, 403]);
const AUTH_DIR = join(homedir(), ".claude");

// Discovery poll backoff: quick initially, slower as time passes without detection
const DISCOVERY_BACKOFF = [
  { untilMs: 5 * 60_000, intervalMs: 60_000 },   // 0-5 min: 60s
  { untilMs: 30 * 60_000, intervalMs: 300_000 }, // 5-30 min: 5 min
  { untilMs: Infinity, intervalMs: 900_000 },    // 30+ min: 15 min
];

const STAMP_DIR = join(homedir(), ".wat321");
const CACHE_FILE = join(STAMP_DIR, "claude-usage.cache.json");
const CLAIM_FILE = join(STAMP_DIR, "claude-usage.claim");

type Listener = (state: ServiceState) => void;

/** States worth writing to the shared cache. Transient/init states are skipped. */
function isCacheableState(state: ServiceState): boolean {
  return (
    state.status === "ok" ||
    state.status === "rate-limited" ||
    state.status === "no-auth" ||
    state.status === "token-expired" ||
    state.status === "offline" ||
    state.status === "error"
  );
}

/**
 * Per-state freshness window. `ok` and `rate-limited` are slow-changing so
 * we keep them for the full interval. Auth/offline/error states might clear
 * the moment the user fixes credentials or the network blip ends, so other
 * instances should recheck them sooner.
 */
function stateFreshnessFor(state: ServiceState): number {
  switch (state.status) {
    case "ok":
    case "rate-limited":
      return CACHE_FRESHNESS_MS;
    case "no-auth":
    case "token-expired":
    case "offline":
    case "error":
      return ERROR_CACHE_FRESHNESS_MS;
    default:
      return CACHE_FRESHNESS_MS;
  }
}

/** Compare two states for deep equality on the fields that matter. */
function statesEqual(a: ServiceState, b: ServiceState): boolean {
  if (a.status !== b.status) return false;
  if (a.status === "ok" && b.status === "ok") {
    return JSON.stringify(a.data) === JSON.stringify(b.data);
  }
  if (a.status === "rate-limited" && b.status === "rate-limited") {
    return a.rateLimitedAt === b.rateLimitedAt && a.retryAfterMs === b.retryAfterMs;
  }
  return true;
}

export class ClaudeUsageSharedService {
  // Initial state reflects auth-dir presence so the first subscriber sees
  // the correct state synchronously. Widgets that hide on "not-connected"
  // never flash their loading text on startup.
  private state: ServiceState = existsSync(AUTH_DIR)
    ? { status: "loading" }
    : { status: "not-connected" };
  private listeners: Set<Listener> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private abortController: AbortController | null = null;
  private consecutiveRateLimits = 0;
  private consecutiveErrors = 0;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private discoveryStartedAt = 0;
  private coordinator = new Coordinator<ServiceState>(
    CACHE_FILE,
    CLAIM_FILE,
    CACHE_FRESHNESS_MS,
    CLAIM_TTL_MS,
    undefined,
    stateFreshnessFor
  );

  start(): void {
    if (!existsSync(AUTH_DIR)) {
      this.setState({ status: "not-connected" });
      this.startDiscovery();
      return;
    }

    // Adopt cached state immediately on startup if available
    const cache = this.coordinator.readCacheFresh();
    if (cache) this.setState(cache.state);

    this.startPolling();
  }

  private startPolling(): void {
    this.stopDiscovery();
    // Delay first refresh cycle. If a fresh cache exists, wait most of the
    // freshness window before trying. Otherwise use cooldown + jitter.
    const cache = this.coordinator.readCache();
    let base: number;
    if (cache && this.coordinator.isFresh(cache)) {
      const elapsed = Date.now() - cache.timestamp;
      base = Math.max(5_000, CACHE_FRESHNESS_MS - elapsed);
    } else {
      const lastFetchTime = cache?.timestamp ?? 0;
      const elapsed = Date.now() - lastFetchTime;
      base = Math.max(5_000, COOLDOWN_MS - elapsed);
    }
    // Random jitter avoids simultaneous instance startups firing in the same ms
    const jitter = Math.floor(Math.random() * 5_000);
    setTimeout(() => {
      if (this.disposed) return;
      this.refresh();
      this.timer = setInterval(() => this.refresh(), POLL_INTERVAL);
    }, base + jitter);
  }

  /** Check for auth directory with exponential backoff (60s -> 5min -> 15min) */
  private startDiscovery(): void {
    this.stopDiscovery();
    if (this.discoveryStartedAt === 0) this.discoveryStartedAt = Date.now();
    this.scheduleDiscoveryTick();
  }

  private scheduleDiscoveryTick(): void {
    const elapsed = Date.now() - this.discoveryStartedAt;
    const step = DISCOVERY_BACKOFF.find((s) => elapsed < s.untilMs) ?? DISCOVERY_BACKOFF[DISCOVERY_BACKOFF.length - 1];
    this.discoveryTimer = setTimeout(() => {
      if (this.disposed) { this.stopDiscovery(); return; }
      if (existsSync(AUTH_DIR)) {
        this.discoveryStartedAt = 0;
        this.setState({ status: "loading" });
        this.startPolling();
        return;
      }
      this.scheduleDiscoveryTick();
    }, step.intervalMs);
  }

  private stopDiscovery(): void {
    if (this.discoveryTimer) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }

  subscribe(listener: Listener): void {
    this.listeners.add(listener);
    listener(this.state);
  }

  unsubscribe(listener: Listener): void {
    this.listeners.delete(listener);
  }

  /** Re-emit current state to all listeners without making API calls */
  rebroadcast(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopDiscovery();
    this.stopCountdownTicker();
    this.abortController?.abort();
    this.listeners.clear();
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

  private startCountdownTicker(): void {
    this.stopCountdownTicker();
    this.countdownTimer = setInterval(() => {
      if (this.state.status === "rate-limited") {
        for (const listener of this.listeners) listener(this.state);
      } else {
        this.stopCountdownTicker();
      }
    }, 60_000);
  }

  private stopCountdownTicker(): void {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight) return;

    // Cache-first: read shared cache. If fresh, use it and skip API.
    const cache = this.coordinator.readCache();
    if (cache && this.coordinator.isFresh(cache)) {
      this.setState(cache.state);
      if (cache.state.status === "ok") this.consecutiveErrors = 0;
      if (cache.state.status === "rate-limited") {
        this.startCountdownTicker();
      } else {
        this.stopCountdownTicker();
      }
      return;
    }

    // Cache is stale or missing - try to claim the refresh slot
    if (!this.coordinator.tryClaim()) {
      // Another instance is refreshing.
      if (cache) {
        // Show slightly stale cache rather than flickering to loading
        this.setState(cache.state);
      } else {
        // No cache yet - schedule a quick retry to pick up the other
        // instance's result once it writes (claim TTL is 30s max)
        setTimeout(() => {
          if (this.disposed) return;
          this.refresh();
        }, 10_000);
      }
      return;
    }

    // We own the claim - actually fetch
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

      const newState: ServiceState = { status: "ok", data: usage, fetchedAt: Date.now() };
      this.setState(newState);
      this.coordinator.writeCache(newState);
      this.stopCountdownTicker();

      if (this.consecutiveRateLimits > 0) {
        this.setPollInterval(POLL_INTERVAL);
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

    // Rate limits always surface immediately and get written to shared cache
    if (statusCode === 429) {
      this.consecutiveRateLimits++;
      this.consecutiveErrors = 0;
      if (this.consecutiveRateLimits === 1) {
        this.setPollInterval(BACKOFF_INTERVAL);
      }
      const newState: ServiceState = {
        status: "rate-limited",
        retryAfterMs: BACKOFF_INTERVAL,
        rateLimitedAt: Date.now(),
      };
      this.setState(newState);
      this.coordinator.writeCache(newState);
      this.startCountdownTicker();
      return;
    }

    // Absorb transient errors silently. Only surface "offline" after 3
    // consecutive failures. Covers stale keep-alive sockets after idle,
    // brief network blips, and server-side reset windows.
    // On startup (loading), also absorb to prevent false "Offline" flash.
    this.consecutiveErrors++;
    if (this.consecutiveErrors < 3) {
      if (this.state.status === "ok" || this.state.status === "loading") return;
    }

    let newState: ServiceState;
    if (statusCode && AUTH_ERROR_CODES.has(statusCode)) {
      newState = {
        status: "token-expired",
        message: `Authentication failed (${statusCode})`,
      };
    } else if (
      message.includes("ENOTFOUND") ||
      message.includes("ETIMEDOUT") ||
      message.includes("EAI_AGAIN") ||
      message.includes("ECONNRESET") ||
      message.includes("Request timed out") ||
      message.includes("ECONNREFUSED")
    ) {
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
      const credPath = join(homedir(), ".claude", ".credentials.json");
      const creds = JSON.parse(readFileSync(credPath, "utf8"));
      return creds?.claudeAiOauth?.accessToken ?? null;
    } catch {
      return null;
    }
  }

  private fetchUsage(token: string): Promise<UsageResponse> {
    return new Promise((resolve, reject) => {
      this.abortController = new AbortController();
      const { signal } = this.abortController;

      const timeout = setTimeout(() => {
        request.destroy();
        reject(new Error("Request timed out"));
      }, REQUEST_TIMEOUT);

      if (signal.aborted) {
        clearTimeout(timeout);
        reject(new Error("Aborted"));
        return;
      }

      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        request.destroy();
        reject(new Error("Aborted"));
      });

      const request = https.request(
        "https://api.anthropic.com/api/oauth/usage",
        {
          method: "GET",
          agent: false, // fresh connection, avoid stale keep-alive sockets after idle
          headers: {
            Authorization: `Bearer ${token}`,
            "anthropic-beta": "oauth-2025-04-20",
          },
        },
        (response) => {
          let data = "";
          response.on("data", (chunk: string) => (data += chunk));
          response.on("end", () => {
            clearTimeout(timeout);
            if (response.statusCode === 200) {
              try {
                resolve(JSON.parse(data));
              } catch {
                reject(new Error("Invalid JSON in API response"));
              }
            } else {
              reject(new Error(`HTTP ${response.statusCode}: ${data}`));
            }
          });
        }
      );

      request.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      request.end();
    });
  }
}
