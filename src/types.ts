import * as vscode from "vscode";

// --- API types ---

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

// --- Service state ---

export type ServiceState =
  | { status: "loading" }
  | { status: "no-auth" }
  | { status: "token-expired"; message: string }
  | { status: "rate-limited"; retryAfterMs: number }
  | { status: "offline"; message: string }
  | { status: "error"; message: string }
  | { status: "ok"; data: UsageResponse; fetchedAt: number };

// --- Widget interface ---

export interface StatusBarWidget extends vscode.Disposable {
  /** Called whenever the service state changes */
  update(state: ServiceState): void;
}
