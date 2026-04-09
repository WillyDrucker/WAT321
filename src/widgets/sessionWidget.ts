import * as vscode from "vscode";
import type { ServiceState, StatusBarWidget } from "../types";
import { makeBar } from "../formatters";
import { buildTooltip } from "./tooltipBuilder";

export class SessionWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor(commandId: string) {
    this.item = vscode.window.createStatusBarItem(
      "wat321.session",
      vscode.StatusBarAlignment.Right,
      1001
    );
    this.item.name = "WAT321: Session";
    this.item.command = commandId;

    // Initial loading state
    this.item.text = "Current session $(loading~spin)";
    this.item.color = undefined;
    this.item.show();
  }

  update(state: ServiceState): void {
    switch (state.status) {
      case "loading":
        this.item.text = "Current session $(loading~spin)";
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

      case "rate-limited":
        this.item.text = "$(warning) WAT321 - Offline";
        this.item.tooltip = "API rate limited. Click or wait to retry.";
        this.item.color = undefined;
        this.item.show();
        break;

      case "offline":
        this.item.text = "$(cloud-offline) WAT321: offline";
        this.item.tooltip = "Network unavailable. Click to retry.";
        this.item.color = undefined;
        this.item.show();
        break;

      case "error":
        this.item.text = "$(warning) WAT321: error";
        this.item.tooltip = state.message;
        this.item.color = undefined;
        this.item.show();
        break;

      case "ok": {
        const pct = state.data.five_hour?.utilization ?? 0;
        this.item.text = `Current session ${makeBar(pct)} ${pct}%`;
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
