import * as vscode from "vscode";
import { buildTooltip } from "../shared/claude-usage/tooltipBuilder";
import type {
  ServiceState,
  StatusBarWidget,
} from "../shared/claude-usage/types";
import { getDisplayMode } from "../shared/displayMode";
import { getClaudeTextColor, renderClaudeBar } from "../shared/ui/heatmap";
import { getWidgetPriority, WIDGET_SLOT } from "../shared/priority";
import { renderWeeklyUsageNonOkState } from "../shared/ui/usageNonOkRenderer";

export class ClaudeUsageWeeklyWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.weekly",
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(WIDGET_SLOT.claudeUsageWeekly)
    );
    this.item.name = "WAT321: Claude Usage (Weekly)";
    this.item.text = "Claude weekly $(loading~spin)";
    this.item.color = undefined;
    // First state delivered by subscribe() decides visibility.
  }

  update(state: ServiceState): void {
    const handled = renderWeeklyUsageNonOkState(this.item, state, {
      loadingText: "Claude weekly $(loading~spin)",
      loadingTooltip: "Fetching Claude usage data...",
    });
    if (handled) return;

    // ok branch
    const pct = state.data.seven_day?.utilization ?? 0;
    const mode = getDisplayMode();

    // `renderClaudeBar` is the single source of truth for Claude
    // bar rendering - heatmap on/off dispatch happens inside the
    // helper so the widget and tooltip both stay in sync.
    if (mode === "minimal") {
      this.item.text = `Claude weekly [${pct}%]`;
    } else if (mode === "compact") {
      this.item.text = `Claude weekly ${renderClaudeBar(pct, 5)} ${pct}%`;
    } else {
      this.item.text = `Claude weekly ${renderClaudeBar(pct, 10)} ${pct}%`;
    }
    this.item.tooltip = buildTooltip(state.data);
    this.item.color = getClaudeTextColor(mode);
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
