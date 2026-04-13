import * as vscode from "vscode";
import { makeBar } from "../shared/claude-usage/formatters";
import { buildTooltip } from "../shared/claude-usage/tooltipBuilder";
import type {
  ServiceState,
  StatusBarWidget,
} from "../shared/claude-usage/types";
import { getDisplayMode } from "../shared/displayMode";
import { getWidgetPriority } from "../shared/priority";

export class ClaudeUsage5hrWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.session",
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(0)
    );
    this.item.name = "WAT321: Claude Usage (5hr)";
    this.item.text = "Claude (5hr) $(loading~spin)";
    this.item.color = undefined;
    // Do not call show() here. The first state emitted by subscribe()
    // decides whether to show (loading/ok) or stay hidden (not-connected).
  }

  update(state: ServiceState): void {
    switch (state.status) {
      case "loading":
        this.item.text = "Claude (5hr) $(loading~spin)";
        this.item.tooltip = "Fetching Claude usage data...";
        this.item.color = undefined;
        this.item.show();
        break;

      case "not-connected":
        // Claude CLI is not installed - hide widget entirely
        this.item.hide();
        break;

      case "no-auth":
        this.item.text = "$(key) Claude - Waiting";
        this.item.tooltip =
          "Waiting for Claude credentials. Will connect automatically when available.";
        this.item.color = undefined;
        this.item.show();
        break;

      case "token-expired":
        this.item.text = "$(key) Claude - Refreshing";
        this.item.tooltip =
          "Claude token refreshing. Will reconnect automatically on next activity.";
        this.item.color = undefined;
        this.item.show();
        break;

      case "rate-limited": {
        this.item.text = "$(warning) Claude Usage - Offline";
        const elapsed = Date.now() - state.rateLimitedAt;
        const remaining = Math.max(
          0,
          Math.ceil((state.retryAfterMs - elapsed) / 60_000)
        );
        this.item.tooltip =
          remaining > 0
            ? `Temporarily paused. Reconnecting in ${remaining} minute${remaining !== 1 ? "s" : ""}...`
            : "Reconnecting...";
        this.item.color = undefined;
        this.item.show();
        break;
      }

      case "offline":
        this.item.text = "$(cloud-offline) Claude - No Network";
        this.item.tooltip = "Network unavailable. Will reconnect automatically.";
        this.item.color = undefined;
        this.item.show();
        break;

      case "error":
        this.item.text = "$(cloud-offline) Claude - Offline";
        this.item.tooltip = "Claude usage temporarily unavailable. Will retry automatically.";
        this.item.color = undefined;
        this.item.show();
        break;

      case "ok": {
        const pct = state.data.five_hour?.utilization ?? 0;
        const mode = getDisplayMode();
        if (mode === "minimal") {
          this.item.text = `Claude (5h): ${pct}%`;
        } else if (mode === "compact") {
          this.item.text = `Claude (5h) ${makeBar(pct, 5)} ${pct}%`;
        } else {
          // Full view keeps the long "5hr" form for space-rich layouts
          this.item.text = `Claude (5hr) ${makeBar(pct)} ${pct}%`;
        }
        this.item.tooltip = buildTooltip(state.data);
        this.item.color =
          pct >= 90
            ? new vscode.ThemeColor("statusBarItem.warningForeground")
            : undefined;
        this.item.show();
        break;
      }
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
