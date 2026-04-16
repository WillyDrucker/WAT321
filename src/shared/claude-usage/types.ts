import type {
  ServiceState as GenericServiceState,
  StatusBarWidget as GenericStatusBarWidget,
} from "../serviceTypes";

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

/** Claude-specialized service state: ok payload is a Claude UsageResponse. */
export type ServiceState = GenericServiceState<UsageResponse>;

/** Claude-specialized status bar widget contract. */
export type StatusBarWidget = GenericStatusBarWidget<ServiceState>;
