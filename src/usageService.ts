import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import https from "https";
import type { UsageResponse, ServiceState } from "./types";

const POLL_INTERVAL = 122_000; // ~2 min
const BACKOFF_INTERVAL = 901_000; // ~15 min
const COOLDOWN_MS = 61_000; // min gap between API calls
const REQUEST_TIMEOUT = 10_000; // 10s fetch timeout
const AUTH_ERROR_CODES = new Set([401, 403]);

type Listener = (state: ServiceState) => void;

export class UsageService {
  private state: ServiceState = { status: "loading" };
  private listeners: Set<Listener> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFetchTime = 0;
  private inFlight = false;
  private abortController: AbortController | null = null;
  private consecutiveRateLimits = 0;
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

  /** Manual refresh (e.g. from command click) */
  async forceRefresh(): Promise<void> {
    await this.refresh(true);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.abortController?.abort();
    this.listeners.clear();
  }

  private setState(s: ServiceState): void {
    if (this.disposed) return;
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  private setPollInterval(ms: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), ms);
  }

  private async refresh(force = false): Promise<void> {
    if (this.disposed) return;

    const now = Date.now();
    if (!force && now - this.lastFetchTime < COOLDOWN_MS) return;
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
    } catch (err: unknown) {
      this.handleFetchError(err);
    } finally {
      this.lastFetchTime = Date.now();
      this.inFlight = false;
    }
  }

  private handleFetchError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    const statusMatch = msg.match(/^HTTP (\d+):/);
    const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : null;

    if (statusCode === 429) {
      this.consecutiveRateLimits++;
      if (this.consecutiveRateLimits === 1) {
        this.setPollInterval(BACKOFF_INTERVAL);
      }
      this.setState({
        status: "rate-limited",
        retryAfterMs: BACKOFF_INTERVAL,
      });
      return;
    }

    if (statusCode && AUTH_ERROR_CODES.has(statusCode)) {
      this.setState({
        status: "token-expired",
        message: `Authentication failed (${statusCode}). Re-login with Claude CLI.`,
      });
      return;
    }

    // Network errors (offline, DNS, timeout)
    if (
      msg.includes("ENOTFOUND") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("EAI_AGAIN") ||
      msg.includes("Request timed out") ||
      msg.includes("ECONNREFUSED")
    ) {
      this.setState({ status: "offline", message: msg });
      return;
    }

    this.setState({ status: "error", message: msg });
  }

  private validateResponse(data: unknown): data is UsageResponse {
    if (data === null || typeof data !== "object") return false;
    const obj = data as Record<string, unknown>;
    // five_hour and seven_day can be null or an object with utilization + resets_at
    for (const key of ["five_hour", "seven_day"]) {
      const val = obj[key];
      if (val === null || val === undefined) continue;
      if (typeof val !== "object") return false;
      const bucket = val as Record<string, unknown>;
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
        req.destroy();
        reject(new Error("Request timed out"));
      }, REQUEST_TIMEOUT);

      if (signal.aborted) {
        clearTimeout(timeout);
        reject(new Error("Aborted"));
        return;
      }
      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        req.destroy();
        reject(new Error("Aborted"));
      });

      const req = https.request(
        "https://api.anthropic.com/api/oauth/usage",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "anthropic-beta": "oauth-2025-04-20",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => {
            clearTimeout(timeout);
            if (res.statusCode === 200) {
              try {
                resolve(JSON.parse(data));
              } catch {
                reject(new Error("Invalid JSON in API response"));
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          });
        }
      );
      req.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      req.end();
    });
  }
}
