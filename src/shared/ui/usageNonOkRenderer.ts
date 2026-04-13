import type * as vscode from "vscode";
import type { ServiceState } from "../types";

/**
 * Shared renderer for the non-OK states of the Claude and Codex
 * usage widgets. Both widgets had identical six-branch switches
 * (loading / not-connected / no-auth / token-expired / rate-limited /
 * offline / error) where only the provider name and the wake command
 * id varied. This helper consolidates the rendering so each widget
 * keeps only its own `ok` branch.
 *
 * Returns `true` if the state was rendered. Returns `false` for the
 * `ok` branch so the caller knows to fall through to its own
 * provider-specific success rendering.
 */

export interface UsageNonOkOptions {
  /** Display name for error states ("Claude" or "Codex"). */
  providerName: string;
  /** Full text shown in the loading state, including any spinner
   * codicon. Varies because the 5h widget uses "(5hr)" / "(5 hour)"
   * label forms its caller has chosen. */
  loadingText: string;
  /** Command id to wire on the click-to-wake affordance during a
   * fallback rate-limit (only fires when `source === "fallback"`). */
  wakeCommand: string;
}

export function renderUsageNonOkState<TData>(
  item: vscode.StatusBarItem,
  state: ServiceState<TData>,
  opts: UsageNonOkOptions
): state is Exclude<ServiceState<TData>, { status: "ok" }> {
  // Default: no click affordance. Only the rate-limited-fallback
  // branch re-enables it as click-to-wake.
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
      // Click-to-wake: only when WAT321 is using its own 15-minute
      // fallback guess (no Retry-After header from the server). A
      // server-directed backoff stays hover-only - we never override
      // a wait the server explicitly asked for.
      if (state.source === "fallback") {
        item.tooltip =
          remaining > 0
            ? `Temporarily paused. Reconnecting in up to ${remaining} minute${remaining !== 1 ? "s" : ""}. Click to resume polling now.`
            : "Reconnecting...";
        item.command = opts.wakeCommand;
      } else {
        item.tooltip =
          remaining > 0
            ? `Temporarily paused. Reconnecting in ${remaining} minute${remaining !== 1 ? "s" : ""}...`
            : "Reconnecting...";
      }
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
