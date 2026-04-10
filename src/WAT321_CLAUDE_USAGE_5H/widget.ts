import * as vscode from "vscode";
import { makeBar } from "../shared/claude-usage/formatters";
import { buildTooltip } from "../shared/claude-usage/tooltipBuilder";
import type {
  ServiceState,
  StatusBarWidget,
} from "../shared/claude-usage/types";

export class ClaudeUsage5hWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.session",
      vscode.StatusBarAlignment.Right,
      1001
    );
    this.item.name = "WAT321: Claude Usage (5h)";
    this.item.text = "Claude (5hr) $(loading~spin)";
    this.item.color = undefined;
    this.item.show();
  }

  update(state: ServiceState): void {
    switch (state.status) {
      case "loading":
        this.item.text = "Claude (5hr) $(loading~spin)";
        this.item.tooltip = "Fetching usage data...";
        this.item.color = undefined;
        this.item.show();
        break;

      case "no-auth":
        this.item.text = "$(key) WAT321: no auth";
        this.item.tooltip =
          "No access token found. Log in with Claude CLI: claude login";
        this.item.color = undefined;
        this.item.show();
        break;

      case "token-expired":
        this.item.text = "$(key) WAT321: re-login needed";
        this.item.tooltip = state.message;
        this.item.color = new vscode.ThemeColor(
          "statusBarItem.warningForeground"
        );
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
            ? `Sleeping ${remaining} minute${remaining !== 1 ? "s" : ""}...`
            : "Reconnecting...";
        this.item.color = undefined;
        this.item.show();
        break;
      }

      case "offline":
        this.item.text = "$(cloud-offline) Claude Usage - Offline";
        this.item.tooltip = "Network unavailable.";
        this.item.color = undefined;
        this.item.show();
        break;

      case "error":
        this.item.hide();
        break;

      case "ok": {
        const pct = state.data.five_hour?.utilization ?? 0;
        this.item.text = `Claude (5hr) ${makeBar(pct)} ${pct}%`;
        this.item.tooltip = buildTooltip(state.data);
        this.item.color = undefined;
        this.item.show();
        break;
      }
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
