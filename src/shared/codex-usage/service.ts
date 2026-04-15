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
import type { CodexUsageResponse, ServiceState } from "./types";

const AUTH_DIR = join(homedir(), ".codex");
const WAT321_DIR = join(homedir(), ".wat321");
const CACHE_FILE = join(WAT321_DIR, "codex-usage.cache.json");
const CLAIM_FILE = join(WAT321_DIR, "codex-usage.claim");
const AUTH_FILE = join(AUTH_DIR, "auth.json");
const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const NO_CACHE_RETRY_MS = 10_000;

interface CodexAuth {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

type Listener = (state: ServiceState) => void;

export class CodexUsageSharedService {
  /**
   * Initial state reflects auth-dir presence so first subscribers see the
   * right state synchronously (no startup flash for missing CLI).
   */
  private state: ServiceState = existsSync(AUTH_DIR)
    ? { status: "loading" }
    : { status: "not-connected" };

  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Pending one-shot timers (startup delay + no-cache retry). Cleared
   * synchronously in `dispose()` so disposed services never fire stale
   * callbacks. See claude-usage/service.ts for the full rationale. */
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
  /** Kickstart escalation counter - mirror of the Claude service.
   * Indexes into `KICKSTART_ESCALATION_MS` to pick the minimum
   * park time before the next kickstart is eligible. Bumps each
   * time a kickstart round fails; resets to 0 on any successful
   * fetch. */
  private consecutiveFailedKickstarts = 0;
  /** Optional callback returning the most recent active-rollout mtime
   * observed by the Codex session token service. Used to gate the
   * activity-driven kickstart out of `rate-limited`. */
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

  rebroadcast(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  /** Inject an activity callback that returns the most recent
   * active-rollout mtime from the Codex session token service. Wired
   * in `bootstrap.ts` after both services are constructed. */
  setActivityProbe(probe: () => number | null): void {
    this.getActivityMs = probe;
  }

  /** Manual user-driven recovery lever - mirror of the Claude
   * service. Called from the Reset WAT321 command to clear the
   * kickstart escalation ladder without forcing an immediate fetch.
   * See claude-usage/service.ts for full rationale. */
  resetKickstartEscalation(): void {
    if (this.disposed) return;
    this.consecutiveFailedKickstarts = 0;
    if (this.state.status === "rate-limited") {
      this.setPollInterval(POLL_INTERVAL_MS);
    }
  }

  /** Activity-driven wake out of the rate-limited park. See the
   * Claude usage service for full rationale - mirror semantics. */
  private wake(): void {
    if (this.disposed) return;
    if (this.state.status !== "rate-limited") return;
    this.consecutiveRateLimits = 0;
    this.postWakeStrikesRemaining = 3;
    this.countdown.stop();
    this.setState({ status: "loading" });
    this.setPollInterval(POLL_INTERVAL_MS);
  }

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

    // Activity-driven kickstart - see claude-usage/service.ts.
    if (this.shouldKickstart(Date.now())) {
      this.wake();
    }

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

    if (!this.coordinator.tryClaim()) {
      if (cache) {
        this.setState(cache.state);
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
      const newState: ServiceState = { status: "no-auth" };
      if (this.state.status !== "no-auth") this.setState(newState);
      this.coordinator.writeCache(newState);
      this.coordinator.releaseClaim();
      return;
    }

    this.inFlight = true;
    try {
      const usage = await this.fetchUsage(auth.token, auth.accountId);

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
        // Kickstart round failed - escalate. See claude-usage.
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

  private validateResponse(data: unknown): data is CodexUsageResponse {
    if (data === null || typeof data !== "object") return false;
    const obj = data as Record<string, unknown>;
    if (typeof obj.plan_type !== "string") return false;
    if (obj.rate_limit !== null && typeof obj.rate_limit !== "object") {
      return false;
    }
    return true;
  }

  private getAuth(): { token: string; accountId: string | undefined } | null {
    try {
      const auth: CodexAuth = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
      const token = auth?.tokens?.access_token;
      if (!token) return null;
      return { token, accountId: auth?.tokens?.account_id };
    } catch {
      return null;
    }
  }

  private fetchUsage(
    token: string,
    accountId: string | undefined
  ): Promise<CodexUsageResponse> {
    this.abortController = new AbortController();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "User-Agent": "codex-cli",
    };
    if (accountId) {
      headers["ChatGPT-Account-Id"] = accountId;
    }
    return httpGetJson<CodexUsageResponse>({
      url: USAGE_ENDPOINT,
      headers,
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

}
