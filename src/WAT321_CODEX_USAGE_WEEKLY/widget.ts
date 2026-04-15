import * as vscode from "vscode";
import { getRemainingPct } from "../shared/codex-usage/formatters";
import { buildTooltip } from "../shared/codex-usage/tooltipBuilder";
import type {
  ServiceState,
  StatusBarWidget,
} from "../shared/codex-usage/types";
import { getDisplayMode } from "../shared/displayMode";
import { getCodexTextColor, renderCodexBar } from "../shared/ui/heatmap";
import { getWidgetPriority, WIDGET_SLOT } from "../shared/priority";
import { renderWeeklyUsageNonOkState } from "../shared/ui/usageNonOkRenderer";

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
    const handled = renderWeeklyUsageNonOkState(this.item, state, {
      loadingText: "Codex weekly $(loading~spin)",
      loadingTooltip: "Fetching Codex usage data...",
    });
    if (handled) return;

    // ok branch
    const usedPct =
      state.data.rate_limit?.secondary_window?.used_percent ?? 0;
    const remainingPct = getRemainingPct(usedPct);
    const mode = getDisplayMode();

    if (mode === "minimal") {
      this.item.text = `Codex weekly [${remainingPct}%]`;
    } else if (mode === "compact") {
      this.item.text = `Codex weekly ${renderCodexBar(usedPct, 5)} ${remainingPct}%`;
    } else {
      this.item.text = `Codex weekly ${renderCodexBar(usedPct, 10)} ${remainingPct}%`;
    }
    this.item.tooltip = buildTooltip(state.data);
    this.item.color = getCodexTextColor(mode, usedPct);
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
