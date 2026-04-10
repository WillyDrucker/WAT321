import * as vscode from "vscode";
import { getRemainingPct, makeBar } from "../shared/codex-usage/formatters";
import { buildTooltip } from "../shared/codex-usage/tooltipBuilder";
import type {
  ServiceState,
  StatusBarWidget,
} from "../shared/codex-usage/types";

export class CodexUsage5hWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor(commandId: string) {
    this.item = vscode.window.createStatusBarItem(
      "wat321.codexSession",
      vscode.StatusBarAlignment.Right,
      999
    );
    this.item.name = "WAT321: Codex Usage (5h)";
    this.item.command = commandId;
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

      case "no-auth":
        this.item.hide();
        break;

      case "token-expired":
        this.item.text = "$(key) WAT321: Codex re-login";
        this.item.tooltip = state.message;
        this.item.color = new vscode.ThemeColor(
          "statusBarItem.warningForeground"
        );
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
            ? `Sleeping ${remaining} minute${remaining !== 1 ? "s" : ""}...`
            : "Reconnecting...";
        this.item.color = undefined;
        this.item.show();
        break;
      }

      case "offline":
        this.item.text = "$(cloud-offline) WAT321: Codex offline";
        this.item.tooltip = "Network unavailable.";
        this.item.color = undefined;
        this.item.show();
        break;

      case "error":
        this.item.hide();
        break;

      case "ok": {
        const usedPct = state.data.rate_limit?.primary_window?.used_percent ?? 0;
        const remainingPct = getRemainingPct(usedPct);
        this.item.text = `Codex (5 hour) ${makeBar(usedPct)} ${remainingPct}%`;
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
