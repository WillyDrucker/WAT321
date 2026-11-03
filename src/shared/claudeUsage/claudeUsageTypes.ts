import type {
  ServiceState as GenericServiceState,
} from "../../engine/serviceTypes";

export interface UsageResponse {
  five_hour: { utilization: number; resets_at: string } | null;
  seven_day: { utilization: number; resets_at: string } | null;
  /** Every limit on the account. A "session" group entry is the 5-hour
   * limit. Unvalidated, so readers check it is a list before use. */
  limits?: Array<{ group?: string } | null> | null;
}

/** Claude-specialized service state: ok payload is a Claude UsageResponse. */
export type ServiceState = GenericServiceState<UsageResponse>;
