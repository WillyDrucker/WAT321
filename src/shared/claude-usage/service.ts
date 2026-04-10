import { readFileSync } from "fs";
import https from "https";
import { homedir } from "os";
import { join } from "path";
import type { ServiceState, UsageResponse } from "./types";

const POLL_INTERVAL = 122_000;
const BACKOFF_INTERVAL = 901_000;
const COOLDOWN_MS = 61_000;
const REQUEST_TIMEOUT = 10_000;
const AUTH_ERROR_CODES = new Set([401, 403]);

type Listener = (state: ServiceState) => void;

export class ClaudeUsageSharedService {
  private state: ServiceState = { status: "loading" };
  private listeners: Set<Listener> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFetchTime = 0;
  private inFlight = false;
  private abortController: AbortController | null = null;
  private consecutiveRateLimits = 0;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  start(): void {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), POLL_INTERVAL);
  }

  subscribe(listener: Listener): void {
    this.listeners.add(listener);
    listener(this.state);
  }

  unsubscribe(listener: Listener): void {
    this.listeners.delete(listener);
  }

  async forceRefresh(): Promise<void> {
    await this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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

    const token = this.getAccessToken();
    if (!token) {
      this.setState({ status: "no-auth" });
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

      this.setState({ status: "ok", data: usage, fetchedAt: Date.now() });

      if (this.consecutiveRateLimits > 0) {
        this.setPollInterval(POLL_INTERVAL);
      }
      this.consecutiveRateLimits = 0;
    } catch (error: unknown) {
      this.handleFetchError(error);
    } finally {
      this.lastFetchTime = Date.now();
      this.inFlight = false;
    }
  }

  private handleFetchError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const statusMatch = message.match(/^HTTP (\d+):/);
    const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : null;

    if (statusCode === 429) {
      this.consecutiveRateLimits++;
      if (this.consecutiveRateLimits === 1) {
        this.setPollInterval(BACKOFF_INTERVAL);
      }
      this.setState({
        status: "rate-limited",
        retryAfterMs: BACKOFF_INTERVAL,
        rateLimitedAt: Date.now(),
      });
      this.startCountdownTicker();
      return;
    }

    if (statusCode && AUTH_ERROR_CODES.has(statusCode)) {
      this.setState({
        status: "token-expired",
        message: `Authentication failed (${statusCode}). Re-login with Claude CLI.`,
      });
      return;
    }

    if (
      message.includes("ENOTFOUND") ||
      message.includes("ETIMEDOUT") ||
      message.includes("EAI_AGAIN") ||
      message.includes("Request timed out") ||
      message.includes("ECONNREFUSED")
    ) {
      this.setState({ status: "offline", message });
      return;
    }

    this.setState({ status: "error", message });
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
