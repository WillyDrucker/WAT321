import * as vscode from "vscode";
import { buildTooltip } from "../shared/claude-usage/tooltipBuilder";
import type {
  ServiceState,
  StatusBarWidget,
} from "../shared/claude-usage/types";
import { getDisplayMode } from "../shared/displayMode";
import { getClaudeTextColor, renderClaudeBar } from "../shared/ui/heatmap";
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
      providerKey: "claude",
      loadingText: "Claude (5hr) $(loading~spin)",
    });
    if (handled) return;

    // ok branch
    const pct = state.data.five_hour?.utilization ?? 0;
    const mode = getDisplayMode();

    // `renderClaudeBar` is the single source of truth for how a
    // Claude progress bar looks at any given pct and width. It
    // internally dispatches to the rolling heatmap bar when
    // `wat321.enableHeatmap` is on, or the default solid-blue bar
    // when off. The hover tooltip builder uses the same helper
    // so the status bar and tooltip always stay in sync.
    if (mode === "minimal") {
      this.item.text = `Claude 5h [${pct}%]`;
    } else if (mode === "compact") {
      this.item.text = `Claude (5h) ${renderClaudeBar(pct, 5)} ${pct}%`;
    } else {
      // Full view keeps the long "5hr" form for space-rich layouts
      this.item.text = `Claude (5hr) ${renderClaudeBar(pct, 10)} ${pct}%`;
    }
    this.item.tooltip = buildTooltip(state.data);
    // Single source of truth for Claude widget text color. The
    // helper handles heatmap-on/off, solo-vs-dual provider, and the
    // minimal-view brand marker in one place.
    this.item.color = getClaudeTextColor(mode);
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
