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
import { renderUsageNonOkState } from "../shared/ui/usageNonOkRenderer";

export class CodexUsage5hrWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.codexSession",
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(WIDGET_SLOT.codexUsage5H)
    );
    this.item.name = "WAT321: Codex Usage (5 hour)";
    this.item.text = "Codex (5 hour) $(loading~spin)";
    this.item.color = undefined;
    // First state delivered by subscribe() decides visibility.
  }

  update(state: ServiceState): void {
    const handled = renderUsageNonOkState(this.item, state, {
      providerName: "Codex",
      providerKey: "codex",
      loadingText: "Codex (5 hour) $(loading~spin)",
    });
    if (handled) return;

    // ok branch
    const usedPct = state.data.rate_limit?.primary_window?.used_percent ?? 0;
    const remainingPct = getRemainingPct(usedPct);
    const mode = getDisplayMode();

    if (mode === "minimal") {
      this.item.text = `Codex 5h [${remainingPct}%]`;
    } else if (mode === "compact") {
      this.item.text = `Codex (5h) ${renderCodexBar(usedPct, 5)} ${remainingPct}%`;
    } else {
      // Full view keeps the long "5 hour" form for space-rich layouts
      this.item.text = `Codex (5 hour) ${renderCodexBar(usedPct, 10)} ${remainingPct}%`;
    }
    this.item.tooltip = buildTooltip(state.data);
    // Single source of truth for Codex widget text color. The helper
    // handles heatmap-on/off, solo-vs-dual provider, the minimal
    // brand marker, and the severity signal in non-green bands.
    this.item.color = getCodexTextColor(mode, usedPct);
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
