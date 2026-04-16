import type * as vscode from "vscode";
import type { ProviderKey } from "../../engine/contracts";
import {
  getCachedStatus,
  getProviderOwner,
  refreshIfStale,
} from "../incidentStatusPoller";
import type { ServiceState } from "../serviceTypes";

/**
 * Shared renderer for the non-OK states of the Claude and Codex
 * usage widgets. Both widgets had identical six-branch switches
 * (loading / not-connected / no-auth / token-expired / rate-limited /
 * offline / error) where only the provider name varied. This helper
 * consolidates the rendering so each widget keeps only its own `ok`
 * branch. No state is ever clickable - recovery from the rate-limited
 * park is fully automatic via the activity-driven kickstart wired in
 * `bootstrap.ts`.
 *
 * Returns `true` if the state was rendered. Returns `false` for the
 * `ok` branch so the caller knows to fall through to its own
 * provider-specific success rendering.
 */

export interface UsageNonOkOptions {
  /** Display name for error states ("Claude" or "Codex"). */
  providerName: string;
  /** Provider key for incident status-page lookups. */
  providerKey: ProviderKey;
  /** Full text shown in the loading state, including any spinner
   * codicon. Varies because the 5h widget uses "(5hr)" / "(5 hour)"
   * label forms its caller has chosen. */
  loadingText: string;
}

export function renderUsageNonOkState<TData>(
  item: vscode.StatusBarItem,
  state: ServiceState<TData>,
  opts: UsageNonOkOptions
): state is Exclude<ServiceState<TData>, { status: "ok" }> {
  // No click affordance on any non-ok state. Recovery from a
  // rate-limit park is fully automatic via the activity-driven
  // kickstart wired in `bootstrap.ts`.
  item.command = undefined;

  switch (state.status) {
    case "loading":
      item.text = opts.loadingText;
      item.tooltip = `Fetching ${opts.providerName} usage data...`;
      item.color = undefined;
      item.show();
      return true;

    case "not-connected":
      item.hide();
      return true;

    case "no-auth":
      item.text = `$(key) ${opts.providerName} - Waiting`;
      item.tooltip = `Waiting for ${opts.providerName} credentials. Will connect automatically when available.`;
      item.color = undefined;
      item.show();
      return true;

    case "token-expired":
      item.text = `$(key) ${opts.providerName} - Refreshing`;
      item.tooltip = `${opts.providerName} token refreshing. Will reconnect automatically on next activity.`;
      item.color = undefined;
      item.show();
      return true;

    case "rate-limited": {
      item.text = `$(warning) ${opts.providerName} Usage - Offline`;
      const elapsed = Date.now() - state.rateLimitedAt;
      const remaining = Math.max(
        0,
        Math.ceil((state.retryAfterMs - elapsed) / 60_000)
      );
      const pausedLine =
        remaining > 0
          ? `Temporarily paused. Reconnecting in up to ${remaining} minute${remaining !== 1 ? "s" : ""}...`
          : "Reconnecting...";
      // Kick a lazy refresh of the provider's public status page.
      // TTL-gated so the actual network call fires at most once per
      // 5 min per window; the countdown ticker's 60-second re-paint
      // picks up a fresh entry on the next tick without explicit
      // rebroadcast plumbing. Silent if the fetch fails.
      refreshIfStale(opts.providerKey);
      const status = getCachedStatus(opts.providerKey);
      // Tooltip order (per design):
      //   1. Anthropic / OpenAI status line (only when an incident
      //      is live - `indicator !== "none"`)
      //   2. API server message (when present on the state)
      //   3. Temporarily paused / reconnecting countdown line
      // Status and server message are additive context; the paused
      // line is the original tooltip and stays at the bottom as the
      // primary action summary.
      const lines: string[] = [];
      if (status && status.indicator !== "none") {
        lines.push(
          `${getProviderOwner(opts.providerKey)} status: ${status.description}`
        );
      }
      if (state.serverMessage) {
        lines.push(`API: ${state.serverMessage}`);
      }
      lines.push(pausedLine);
      item.tooltip = lines.join("\n");
      item.color = undefined;
      item.show();
      return true;
    }

    case "offline":
      item.text = `$(cloud-offline) ${opts.providerName} - No Network`;
      item.tooltip = "Network unavailable. Will reconnect automatically.";
      item.color = undefined;
      item.show();
      return true;

    case "error":
      item.text = `$(cloud-offline) ${opts.providerName} - Offline`;
      item.tooltip = `${opts.providerName} usage temporarily unavailable. Will retry automatically.`;
      item.color = undefined;
      item.show();
      return true;

    case "ok":
      return false;
  }
}

/** Shared renderer for the non-OK states of the Claude and Codex
 * weekly usage widgets. Weekly intentionally hides on every error
 * state (not-connected / no-auth / token-expired / rate-limited /
 * offline / error) because the matching 5h widget already surfaces
 * those conditions - duplicating the pill on both rows would be
 * visual clutter. Only the `loading` branch is visible, so the body
 * is much shorter than `renderUsageNonOkState`.
 *
 * Returns `true` if the state was handled. Returns `false` for the
 * `ok` branch so the caller falls through to its own provider-
 * specific success rendering. */
export function renderWeeklyUsageNonOkState<TData>(
  item: vscode.StatusBarItem,
  state: ServiceState<TData>,
  opts: { loadingText: string; loadingTooltip: string }
): state is Exclude<ServiceState<TData>, { status: "ok" }> {
  switch (state.status) {
    case "loading":
      item.text = opts.loadingText;
      item.tooltip = opts.loadingTooltip;
      item.color = undefined;
      item.show();
      return true;

    case "not-connected":
    case "no-auth":
    case "token-expired":
    case "rate-limited":
    case "offline":
    case "error":
      item.hide();
      return true;

    case "ok":
      return false;
  }
}
