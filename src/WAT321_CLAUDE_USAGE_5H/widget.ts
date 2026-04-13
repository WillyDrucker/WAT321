import * as vscode from "vscode";
import { makeBar } from "../shared/claude-usage/formatters";
import { buildTooltip } from "../shared/claude-usage/tooltipBuilder";
import type {
  ServiceState,
  StatusBarWidget,
} from "../shared/claude-usage/types";
import { getDisplayMode } from "../shared/displayMode";
import { getWidgetPriority, WIDGET_SLOT } from "../shared/priority";
import { renderUsageNonOkState } from "../shared/ui/usageNonOkRenderer";

export class ClaudeUsage5hrWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.session",
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(WIDGET_SLOT.claudeUsage5H)
    );
    this.item.name = "WAT321: Claude Usage (5hr)";
    this.item.text = "Claude (5hr) $(loading~spin)";
    this.item.color = undefined;
    // Do not call show() here. The first state emitted by subscribe()
    // decides whether to show (loading/ok) or stay hidden (not-connected).
  }

  update(state: ServiceState): void {
    const handled = renderUsageNonOkState(this.item, state, {
      providerName: "Claude",
      loadingText: "Claude (5hr) $(loading~spin)",
      wakeCommand: "wat321.wakeClaudeUsage",
    });
    if (handled) return;

    // ok branch
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
  }

  dispose(): void {
    this.item.dispose();
  }
}
