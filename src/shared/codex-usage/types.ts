import type {
  ServiceState as GenericServiceState,
  StatusBarWidget as GenericStatusBarWidget,
} from "../serviceTypes";

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

interface AdditionalRateLimit {
  limit_name: string;
  metered_feature: string;
  rate_limit: {
    allowed: boolean;
    limit_reached: boolean;
    primary_window: RateLimitWindow | null;
    secondary_window: RateLimitWindow | null;
  } | null;
}

/** Codex-specialized service state: ok payload is a CodexUsageResponse. */
export type ServiceState = GenericServiceState<CodexUsageResponse>;

/** Codex-specialized status bar widget contract. */
export type StatusBarWidget = GenericStatusBarWidget<ServiceState>;
