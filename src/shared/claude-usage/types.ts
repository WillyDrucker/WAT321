import * as vscode from "vscode";

export interface UsageResponse {
  five_hour: { utilization: number; resets_at: string } | null;
  seven_day: { utilization: number; resets_at: string } | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
  } | null;
}

export type ServiceState =
  | { status: "loading" }
  | { status: "not-connected" }
  | { status: "no-auth" }
  | { status: "token-expired"; message: string }
  | { status: "rate-limited"; retryAfterMs: number; rateLimitedAt: number }
  | { status: "offline"; message: string }
  | { status: "error"; message: string }
  | { status: "ok"; data: UsageResponse; fetchedAt: number };

export interface StatusBarWidget extends vscode.Disposable {
  update(state: ServiceState): void;
}
