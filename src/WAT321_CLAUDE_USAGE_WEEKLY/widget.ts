import * as vscode from "vscode";
import { makeBar } from "../shared/claude-usage/formatters";
import { buildTooltip } from "../shared/claude-usage/tooltipBuilder";
import type {
  ServiceState,
  StatusBarWidget,
} from "../shared/claude-usage/types";

export class ClaudeUsageWeeklyWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.weekly",
      vscode.StatusBarAlignment.Right,
      1000
    );
    this.item.name = "WAT321: Claude Usage (Weekly)";
    this.item.text = "Claude weekly $(loading~spin)";
    this.item.color = undefined;
    this.item.show();
  }

  update(state: ServiceState): void {
    switch (state.status) {
      case "loading":
        this.item.text = "Claude weekly $(loading~spin)";
        this.item.tooltip = "Fetching usage data...";
        this.item.color = undefined;
        this.item.show();
        break;

      case "no-auth":
      case "token-expired":
      case "rate-limited":
      case "offline":
      case "error":
        this.item.hide();
        break;

      case "ok": {
        const pct = state.data.seven_day?.utilization ?? 0;
        this.item.text = `Claude weekly ${makeBar(pct)} ${pct}%`;
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
