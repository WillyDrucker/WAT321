import * as vscode from "vscode";
import type { ServiceState, StatusBarWidget } from "../types";
import { makeBar } from "../formatters";
import { buildTooltip } from "./tooltipBuilder";

export class WeeklyWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor(commandId: string) {
    this.item = vscode.window.createStatusBarItem(
      "wat321.weekly",
      vscode.StatusBarAlignment.Right,
      1000
    );
    this.item.name = "WAT321: Weekly";
    this.item.command = commandId;

    // Initial loading state
    this.item.text = "Weekly limits $(loading~spin)";
    this.item.color = undefined;
    this.item.show();
  }

  update(state: ServiceState): void {
    switch (state.status) {
      case "loading":
        this.item.text = "Weekly limits $(loading~spin)";
        this.item.tooltip = "Fetching usage data...";
        this.item.color = undefined;
        this.item.show();
        break;

      // Session widget handles all non-ok states; weekly hides
      case "no-auth":
      case "token-expired":
      case "rate-limited":
      case "offline":
      case "error":
        this.item.hide();
        break;

      case "ok": {
        const pct = state.data.seven_day?.utilization ?? 0;
        this.item.text = `Weekly limits ${makeBar(pct)} ${pct}%`;
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
