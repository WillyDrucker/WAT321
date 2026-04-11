import * as vscode from "vscode";

export interface CodexUsageResponse {
  plan_type: string;
  rate_limit: {
    allowed: boolean;
    limit_reached: boolean;
    primary_window: RateLimitWindow | null;
    secondary_window: RateLimitWindow | null;
  } | null;
  credits: {
    has_credits: boolean;
    unlimited: boolean;
    balance: string | null;
    approx_local_messages: [number, number] | null;
    approx_cloud_messages: [number, number] | null;
  } | null;
  code_review_rate_limit: {
    allowed: boolean;
    limit_reached: boolean;
    primary_window: RateLimitWindow | null;
    secondary_window: RateLimitWindow | null;
  } | null;
  additional_rate_limits: AdditionalRateLimit[] | null;
}

export interface RateLimitWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number;
}

export interface AdditionalRateLimit {
  limit_name: string;
  metered_feature: string;
  rate_limit: {
    allowed: boolean;
    limit_reached: boolean;
    primary_window: RateLimitWindow | null;
    secondary_window: RateLimitWindow | null;
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
  | { status: "ok"; data: CodexUsageResponse; fetchedAt: number };

export interface StatusBarWidget extends vscode.Disposable {
  update(state: ServiceState): void;
}
