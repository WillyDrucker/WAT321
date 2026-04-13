import * as vscode from "vscode";
import { getRemainingPct, makeBar } from "../shared/codex-usage/formatters";
import { buildTooltip } from "../shared/codex-usage/tooltipBuilder";
import type {
  ServiceState,
  StatusBarWidget,
} from "../shared/codex-usage/types";
import { getDisplayMode } from "../shared/displayMode";
import { getWidgetPriority, WIDGET_SLOT } from "../shared/priority";

export class CodexUsageWeeklyWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.codexWeekly",
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(WIDGET_SLOT.codexUsageWeekly)
    );
    this.item.name = "WAT321: Codex Usage (Weekly)";
    this.item.text = "Codex weekly $(loading~spin)";
    this.item.color = undefined;
    // First state delivered by subscribe() decides visibility.
  }

  update(state: ServiceState): void {
    switch (state.status) {
      case "loading":
        this.item.text = "Codex weekly $(loading~spin)";
        this.item.tooltip = "Fetching Codex usage data...";
        this.item.color = undefined;
        this.item.show();
        break;

      case "not-connected":
      case "no-auth":
      case "token-expired":
      case "rate-limited":
      case "offline":
      case "error":
        this.item.hide();
        break;

      case "ok": {
        const usedPct =
          state.data.rate_limit?.secondary_window?.used_percent ?? 0;
        const remainingPct = getRemainingPct(usedPct);
        const mode = getDisplayMode();
        if (mode === "minimal") {
          this.item.text = `Codex weekly: ${remainingPct}%`;
        } else if (mode === "compact") {
          this.item.text = `Codex weekly ${makeBar(usedPct, 5)} ${remainingPct}%`;
        } else {
          this.item.text = `Codex weekly ${makeBar(usedPct)} ${remainingPct}%`;
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
