import * as vscode from "vscode";
import { getRemainingPct, makeBar } from "../shared/codex-usage/formatters";
import { buildTooltip } from "../shared/codex-usage/tooltipBuilder";
import type {
  ServiceState,
  StatusBarWidget,
} from "../shared/codex-usage/types";
import { getDisplayMode } from "../shared/displayMode";
import { getWidgetPriority } from "../shared/priority";

export class CodexUsage5hrWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.codexSession",
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(2)
    );
    this.item.name = "WAT321: Codex Usage (5 hour)";
    this.item.text = "Codex (5 hour) $(loading~spin)";
    this.item.color = undefined;
    this.item.show();
  }

  update(state: ServiceState): void {
    switch (state.status) {
      case "loading":
        this.item.text = "Codex (5 hour) $(loading~spin)";
        this.item.tooltip = "Fetching Codex usage data...";
        this.item.color = undefined;
        this.item.show();
        break;

      case "not-connected":
        this.item.text = "$(info) Codex - Not Connected";
        this.item.tooltip =
          "Codex tools will activate automatically when Codex CLI is used.";
        this.item.color = undefined;
        this.item.show();
        break;

      case "no-auth":
        this.item.text = "$(key) Codex - Waiting";
        this.item.tooltip =
          "Waiting for Codex credentials. Will connect automatically when available.";
        this.item.color = undefined;
        this.item.show();
        break;

      case "token-expired":
        this.item.text = "$(key) Codex - Refreshing";
        this.item.tooltip =
          "Codex token refreshing. Will reconnect automatically on next activity.";
        this.item.color = undefined;
        this.item.show();
        break;

      case "rate-limited": {
        this.item.text = "$(warning) Codex Usage - Offline";
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
        this.item.text = "$(cloud-offline) Codex - No Network";
        this.item.tooltip = "Network unavailable. Will reconnect automatically.";
        this.item.color = undefined;
        this.item.show();
        break;

      case "error":
        this.item.text = "$(cloud-offline) Codex - Offline";
        this.item.tooltip = "Codex usage temporarily unavailable. Will retry automatically.";
        this.item.color = undefined;
        this.item.show();
        break;

      case "ok": {
        const usedPct = state.data.rate_limit?.primary_window?.used_percent ?? 0;
        const remainingPct = getRemainingPct(usedPct);
        const mode = getDisplayMode();
        if (mode === "minimal") {
          this.item.text = `Codex (5 hour): ${remainingPct}%`;
        } else if (mode === "compact") {
          this.item.text = `Codex (5 hour) ${makeBar(usedPct, 5)} ${remainingPct}%`;
        } else {
          this.item.text = `Codex (5 hour) ${makeBar(usedPct)} ${remainingPct}%`;
        }
        this.item.tooltip = buildTooltip(state.data);
        this.item.color =
          remainingPct <= 10
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
