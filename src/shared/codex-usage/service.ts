import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import https from "https";
import { homedir } from "os";
import { join } from "path";
import type { CodexUsageResponse, ServiceState } from "./types";

const POLL_INTERVAL = 122_000;
const BACKOFF_INTERVAL = 901_000;
const COOLDOWN_MS = 61_000;
const REQUEST_TIMEOUT = 10_000;
const DISCOVERY_INTERVAL = 60_000;
const AUTH_ERROR_CODES = new Set([401, 403]);
const AUTH_DIR = join(homedir(), ".codex");

interface CodexAuth {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

// Persist last fetch time across reloads to prevent rate-limit on rapid restarts
const STAMP_DIR = join(homedir(), ".wat321");
const CODEX_STAMP_FILE = join(STAMP_DIR, "codex-usage-last-fetch");

function readStamp(): number {
  try {
    const val = parseInt(readFileSync(CODEX_STAMP_FILE, "utf8"), 10) || 0;
    return val > Date.now() ? 0 : val;
  } catch {
    return 0;
  }
}

function writeStamp(time: number): void {
  try {
    if (!existsSync(STAMP_DIR)) mkdirSync(STAMP_DIR, { recursive: true });
    writeFileSync(CODEX_STAMP_FILE, String(time));
  } catch {
    // best-effort
  }
}

type Listener = (state: ServiceState) => void;

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: string,
    public readonly retryAfterMs?: number
  ) {
    super(`HTTP ${statusCode}: ${body}`);
  }
}

export class CodexUsageSharedService {
  private state: ServiceState = { status: "loading" };
  private listeners: Set<Listener> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFetchTime = readStamp();
  private inFlight = false;
  private abortController: AbortController | null = null;
  private consecutiveRateLimits = 0;
  private consecutiveErrors = 0;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (!existsSync(AUTH_DIR)) {
      this.setState({ status: "not-connected" });
      this.startDiscovery();
      return;
    }
    this.startPolling();
  }

  private startPolling(): void {
    this.stopDiscovery();
    // Delay first fetch - use remaining cooldown or 5s minimum
    const elapsed = Date.now() - this.lastFetchTime;
    const remaining = Math.max(5_000, COOLDOWN_MS - elapsed);
    setTimeout(() => {
      if (this.disposed) return;
      this.refresh();
      this.timer = setInterval(() => this.refresh(), POLL_INTERVAL);
    }, remaining);
  }

  /** Check every 60s if auth directory appears */
  private startDiscovery(): void {
    this.discoveryTimer = setInterval(() => {
      if (this.disposed) { this.stopDiscovery(); return; }
      if (existsSync(AUTH_DIR)) {
        this.setState({ status: "loading" });
        this.startPolling();
      }
    }, DISCOVERY_INTERVAL);
  }

  private stopDiscovery(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
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

    const now = Date.now();
    if (now - this.lastFetchTime < COOLDOWN_MS) return;
    if (this.inFlight) return;

    const auth = this.getAuth();
    if (!auth) {
      if (this.state.status !== "no-auth") this.setState({ status: "no-auth" });
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

      this.setState({ status: "ok", data: usage, fetchedAt: Date.now() });
      this.stopCountdownTicker();

      if (this.consecutiveRateLimits > 0) {
        this.setPollInterval(POLL_INTERVAL);
      }
      this.consecutiveRateLimits = 0;
      this.consecutiveErrors = 0;
    } catch (error: unknown) {
      this.handleFetchError(error);
    } finally {
      this.lastFetchTime = Date.now();
      writeStamp(this.lastFetchTime);
      this.inFlight = false;
    }
  }

  private handleFetchError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode =
      error instanceof HttpError ? error.statusCode : null;

    // Rate limits always surface immediately
    if (statusCode === 429) {
      this.consecutiveRateLimits++;
      this.consecutiveErrors = 0;
      const retryAfterMs =
        error instanceof HttpError && error.retryAfterMs
          ? error.retryAfterMs
          : BACKOFF_INTERVAL;
      if (this.consecutiveRateLimits === 1) {
        this.setPollInterval(retryAfterMs);
      }
      this.setState({
        status: "rate-limited",
        retryAfterMs,
        rateLimitedAt: Date.now(),
      });
      this.startCountdownTicker();
      return;
    }

    // Track consecutive non-429 errors. If we have good data and this is
    // the first failure (transient after alt-tab, idle, etc.), silently
    // keep showing cached data and retry on the next poll cycle.
    this.consecutiveErrors++;
    if (this.state.status === "ok" && this.consecutiveErrors < 2) return;

    if (statusCode && AUTH_ERROR_CODES.has(statusCode)) {
      this.setState({
        status: "token-expired",
        message: `Authentication failed (${statusCode})`,
      });
      return;
    }

    if (
      message.includes("ENOTFOUND") ||
      message.includes("ETIMEDOUT") ||
      message.includes("EAI_AGAIN") ||
      message.includes("ECONNRESET") ||
      message.includes("Request timed out") ||
      message.includes("ECONNREFUSED")
    ) {
      this.setState({ status: "offline", message });
      return;
    }

    this.setState({ status: "error", message });
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
      const authPath = join(homedir(), ".codex", "auth.json");
      const auth: CodexAuth = JSON.parse(readFileSync(authPath, "utf8"));
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

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "User-Agent": "codex-cli",
      };
      if (accountId) {
        headers["ChatGPT-Account-Id"] = accountId;
      }

      const request = https.request(
        "https://chatgpt.com/backend-api/wham/usage",
        { method: "GET", headers },
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
              const retryAfterHeader = response.headers["retry-after"];
              const retryAfterValue = Array.isArray(retryAfterHeader)
                ? retryAfterHeader[0]
                : retryAfterHeader;
              reject(
                new HttpError(
                  response.statusCode ?? 0,
                  data,
                  this.parseRetryAfterMs(retryAfterValue)
                )
              );
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

  private parseRetryAfterMs(value: string | undefined): number | undefined {
    if (!value) return undefined;

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(1_000, Math.round(seconds * 1_000));
    }

    const retryAt = Date.parse(value);
    if (Number.isNaN(retryAt)) return undefined;
    return Math.max(1_000, retryAt - Date.now());
  }
}
