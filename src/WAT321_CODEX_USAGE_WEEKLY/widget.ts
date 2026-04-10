import * as vscode from "vscode";
import { getRemainingPct, makeBar } from "../shared/codex-usage/formatters";
import { buildTooltip } from "../shared/codex-usage/tooltipBuilder";
import type {
  ServiceState,
  StatusBarWidget,
} from "../shared/codex-usage/types";

export class CodexUsageWeeklyWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.codexWeekly",
      vscode.StatusBarAlignment.Right,
      998
    );
    this.item.name = "WAT321: Codex Usage (Weekly)";
    this.item.text = "Codex weekly $(loading~spin)";
    this.item.color = undefined;
    this.item.show();
  }

  update(state: ServiceState): void {
    switch (state.status) {
      case "loading":
        this.item.text = "Codex weekly $(loading~spin)";
        this.item.tooltip = "Fetching Codex usage data...";
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
        const usedPct =
          state.data.rate_limit?.secondary_window?.used_percent ?? 0;
        const remainingPct = getRemainingPct(usedPct);
        this.item.text = `Codex weekly ${makeBar(usedPct)} ${remainingPct}%`;
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
