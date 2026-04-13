import * as vscode from "vscode";
import type { CodexTokenWidgetState, StatusBarWidget } from "./types";
import { CodexSessionTokenService } from "./service";
import { formatPct, formatTokens } from "../shared/ui/tokenFormatters";
import { buildSessionTokenTooltip } from "../shared/ui/sessionTokenTooltip";
import { getDisplayMode } from "../shared/displayMode";
import { getWidgetPriority, WIDGET_SLOT } from "../shared/priority";

const THOUGHT = "\u{1F4AD}";

export class CodexSessionTokensWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.codexSessionTokens",
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(WIDGET_SLOT.codexSessionTokens)
    );
    this.item.name = "WAT321: Codex Session Tokens";
    this.item.text = `${THOUGHT} Codex -`;
    this.item.tooltip = "No active Codex session";
    // First state delivered by subscribe() decides visibility.
  }

  update(state: CodexTokenWidgetState): void {
    switch (state.status) {
      case "not-installed":
        // Codex CLI is not installed - hide widget entirely
        this.item.hide();
        break;

      case "no-session":
      case "waiting":
        this.item.text = `${THOUGHT} Codex -`;
        this.item.tooltip = "No active Codex session";
        this.item.color = undefined;
        this.item.show();
        break;

      case "ok": {
        const { session } = state;
        const usedPct = session.autoCompactTokens > 0
          ? Math.min(100, Math.round((session.contextUsed / session.autoCompactTokens) * 100))
          : 0;

        const mode = getDisplayMode();
        if (mode === "minimal" || mode === "compact") {
          this.item.text = `${THOUGHT} Codex ${formatTokens(session.contextUsed)} ${formatPct(usedPct)}`;
        } else {
          this.item.text =
            `${THOUGHT} Codex ${formatTokens(session.contextUsed)} / ` +
            `${formatTokens(session.autoCompactTokens)} ${formatPct(usedPct)}`;
        }

        this.item.color =
          usedPct >= 90
            ? new vscode.ThemeColor("statusBarItem.warningForeground")
            : undefined;

        this.item.tooltip = buildSessionTokenTooltip({
          provider: "Codex",
          sessionTitle: session.sessionTitle,
          label: session.label,
          contextUsed: session.contextUsed,
          ceiling: session.autoCompactTokens,
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

export function activateCodexTokenWidget(
  service: CodexSessionTokenService
): vscode.Disposable[] {
  const widget = new CodexSessionTokensWidget();
  const listener = (state: CodexTokenWidgetState) => widget.update(state);
  service.subscribe(listener);

  return [widget, { dispose: () => service.unsubscribe(listener) }];
}
