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
import type { CodexUsageResponse, ServiceState } from "./types";

const AUTH_DIR = join(homedir(), ".codex");
const STAMP_DIR = join(homedir(), ".wat321");
const CACHE_FILE = join(STAMP_DIR, "codex-usage.cache.json");
const CLAIM_FILE = join(STAMP_DIR, "codex-usage.claim");
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
        setTimeout(() => {
          if (this.disposed) return;
          this.refresh();
        }, NO_CACHE_RETRY_MS);
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
    const statusCode = error instanceof HttpError ? error.statusCode : null;

    if (statusCode === 429) {
      this.consecutiveRateLimits++;
      this.consecutiveErrors = 0;
      const retryAfterMs =
        error instanceof HttpError && error.retryAfterMs
          ? error.retryAfterMs
          : RATE_LIMIT_BACKOFF_MS;
      if (this.consecutiveRateLimits === 1) {
        this.setPollInterval(retryAfterMs);
      }
      const newState: ServiceState = {
        status: "rate-limited",
        retryAfterMs,
        rateLimitedAt: Date.now(),
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
