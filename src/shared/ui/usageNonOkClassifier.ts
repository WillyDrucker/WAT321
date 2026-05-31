import type { ProviderKey } from "../../engine/contracts";
import type { ServiceState as GenericServiceState } from "../../engine/serviceTypes";
import {
  getCachedStatus,
  getProviderOwner,
} from "../incidentStatusPoller";

/**
 * Shared non-ok classifier. Pure mapping from every non-ok
 * `ServiceState` variant to a one-word label (status-bar friendly)
 * plus a longer tooltip detail. Used by both `usageWidget` and
 * `usageErrorWidget` so the two surfaces never drift in their
 * disclosure copy.
 *
 * Labels are one-word so the status-bar surface stays compact:
 * `Loading`, `Not Connected`, `Signed Out`, `Refreshing`, `Paused`,
 * `Idle`, `Offline`. The classifier itself does no I/O. The incident
 * refresh kick for the rate-limited path is the caller's
 * responsibility - the bar widget owns that kick so the error widget
 * does not double-fire it on every update.
 */

interface NonOkClassification {
  label: string;
  detail: string;
}

export function classifyUsageNonOk<TData>(
  state: Exclude<GenericServiceState<TData>, { status: "ok" }>,
  providerName: string,
  providerKey: ProviderKey
): NonOkClassification {
  switch (state.status) {
    case "loading":
      return {
        label: "Loading",
        detail: `Fetching ${providerName} usage data.`,
      };
    case "not-connected":
      return {
        label: "Not Connected",
        detail: `${providerName} is not connected yet. Bars appear automatically once usage data lands.`,
      };
    case "no-auth":
      return {
        label: "Signed Out",
        detail: `${providerName} is signed out. Will reconnect automatically when credentials return.`,
      };
    case "token-expired":
      return {
        label: "Refreshing",
        detail: `${providerName} is refreshing credentials. Will reconnect automatically on next activity.`,
      };
    case "rate-limited": {
      if (state.isColdStart === true) {
        const server = state.serverMessage
          ? ` API: ${state.serverMessage}.`
          : "";
        return {
          label: "Idle",
          detail: `Idle (cold-poll absorbed).${server} Usage data becomes available after ${providerName}'s next activity.`,
        };
      }
      const elapsed = Date.now() - state.rateLimitedAt;
      const remainingMin = Math.max(
        0,
        Math.ceil((state.retryAfterMs - elapsed) / 60_000)
      );
      const countdown =
        remainingMin > 0
          ? ` Reconnecting in up to ${remainingMin} minute${remainingMin !== 1 ? "s" : ""}.`
          : " Reconnecting.";
      const server = state.serverMessage
        ? ` API: ${state.serverMessage}.`
        : "";
      // Surface the cached status-page entry when an incident is live.
      // The status-page refresh kick is fired by the bar widget's
      // update path, not here, so this classifier stays pure.
      const status = getCachedStatus(providerKey);
      const incident =
        status && status.indicator !== "none"
          ? ` ${getProviderOwner(providerKey)} status: ${status.description}.`
          : "";
      return {
        label: "Paused",
        detail: `Temporarily throttled by ${providerName} (their side, not yours).${countdown}${server}${incident}`,
      };
    }
    case "offline":
      return {
        label: "Offline",
        detail: "Network unavailable. Will reconnect automatically.",
      };
    case "error":
      return {
        label: "Idle",
        detail: `${providerName} usage temporarily unavailable. Will retry automatically.`,
      };
  }
}
