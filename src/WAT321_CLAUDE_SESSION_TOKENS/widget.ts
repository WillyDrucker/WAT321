import * as vscode from "vscode";
import type { WidgetState, StatusBarWidget } from "./types";
import { formatTokens, formatPct } from "../shared/ui/tokenFormatters";
import { buildSessionTokenTooltip } from "../shared/ui/sessionTokenTooltip";
import { getDisplayMode } from "../shared/displayMode";
import { getSessionTokenColor } from "../shared/ui/heatmap";
import { prefixForMode } from "../shared/ui/sessionTokenPrefix";
import { getWidgetPriority, WIDGET_SLOT } from "../shared/priority";

export class ClaudeSessionTokensWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.sessionTokens",
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(WIDGET_SLOT.claudeSessionTokens)
    );
    this.item.name = "WAT321: Claude Session Tokens";
    this.item.text = `${prefixForMode()} Claude -`;
    this.item.tooltip = "No active Claude session";
    // First state delivered by subscribe() decides visibility.
  }

  update(state: WidgetState): void {
    switch (state.status) {
      case "not-installed":
        // Claude CLI is not installed - hide widget entirely
        this.item.hide();
        break;

      case "no-session":
      case "waiting":
        this.item.text = `${prefixForMode()} Claude -`;
        this.item.tooltip = "No active Claude session";
        this.item.color = undefined;
        this.item.show();
        break;

      case "ok": {
        const { session } = state;
        const ceilingTokens = Math.round(
          (session.autoCompactPct / 100) * session.contextWindowSize
        );
        const pctOfCeiling =
          ceilingTokens > 0
            ? Math.min(100, Math.round((session.contextUsed / ceilingTokens) * 100))
            : 0;

        const mode = getDisplayMode();
        const prefix = prefixForMode();
        if (mode === "minimal" || mode === "compact") {
          this.item.text = `${prefix} Claude ${formatTokens(session.contextUsed)} ${formatPct(pctOfCeiling)}`;
        } else {
          this.item.text = `${prefix} Claude ${formatTokens(session.contextUsed)} / ${formatTokens(ceilingTokens)} ${formatPct(pctOfCeiling)}`;
        }

        this.item.color = getSessionTokenColor(pctOfCeiling);

        this.item.tooltip = buildSessionTokenTooltip({
          provider: "Claude",
          sessionTitle: session.sessionTitle,
          label: session.label,
          contextUsed: session.contextUsed,
          ceiling: ceilingTokens,
          lastActiveAt:
            session.source === "lastKnown" ? session.lastActiveAt : undefined,
        });
        this.item.show();
        break;
      }
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
