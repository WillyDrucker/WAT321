import * as vscode from "vscode";
import type { WidgetState, StatusBarWidget } from "./types";
import { formatTokens, formatPct } from "../shared/ui/tokenFormatters";
import { buildSessionTokenTooltip } from "../shared/ui/sessionTokenTooltip";
import { ClaudeSessionTokenService } from "./service";
import { getDisplayMode } from "../shared/displayMode";
import { getWidgetPriority, WIDGET_SLOT } from "../shared/priority";

const THOUGHT = "\u{1F4AD}"; // U+1F4AD THOUGHT BALLOON

export class ClaudeSessionTokensWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.sessionTokens",
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(WIDGET_SLOT.claudeSessionTokens)
    );
    this.item.name = "WAT321: Claude Session Tokens";
    this.item.text = `${THOUGHT} Claude -`;
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
        this.item.text = `${THOUGHT} Claude -`;
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
        if (mode === "minimal" || mode === "compact") {
          this.item.text = `${THOUGHT} Claude ${formatTokens(session.contextUsed)} ${formatPct(pctOfCeiling)}`;
        } else {
          this.item.text = `${THOUGHT} Claude ${formatTokens(session.contextUsed)} / ${formatTokens(ceilingTokens)} ${formatPct(pctOfCeiling)}`;
        }

        this.item.color =
          pctOfCeiling >= 90
            ? new vscode.ThemeColor("statusBarItem.warningForeground")
            : undefined;

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

export function activateClaudeTokenWidget(
  service: ClaudeSessionTokenService
): vscode.Disposable[] {
  const widget = new ClaudeSessionTokensWidget();
  const listener = (state: WidgetState) => widget.update(state);
  service.subscribe(listener);

  return [widget, { dispose: () => service.unsubscribe(listener) }];
}
