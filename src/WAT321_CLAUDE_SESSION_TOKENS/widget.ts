import * as vscode from "vscode";
import type { WidgetState, ResolvedSession, StatusBarWidget } from "./types";
import { formatTokens, formatPct, makeTokenBar } from "../shared/ui/tokenFormatters";
import { ClaudeSessionTokenService } from "./service";
import { getDisplayMode } from "../shared/displayMode";
import { getWidgetPriority } from "../shared/priority";

export class ClaudeSessionTokensWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.sessionTokens",
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(4)
    );
    this.item.name = "WAT321: Claude Session Tokens";
    this.item.text = "🗜️ Claude -";
    this.item.tooltip = "No active Claude session";
    this.item.show();
  }

  update(state: WidgetState): void {
    switch (state.status) {
      case "not-installed":
        // Claude CLI is not installed - hide widget entirely
        this.item.hide();
        break;

      case "no-session":
      case "waiting":
        this.item.text = "🗜️ Claude -";
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
          this.item.text = `🗜️ Claude ${formatTokens(session.contextUsed)} ${formatPct(pctOfCeiling)}`;
        } else {
          this.item.text = `🗜️ Claude ${formatTokens(session.contextUsed)} / ${formatTokens(ceilingTokens)} ${formatPct(pctOfCeiling)}`;
        }

        this.item.color =
          pctOfCeiling >= 90
            ? new vscode.ThemeColor("statusBarItem.warningForeground")
            : undefined;

        this.item.tooltip = this.buildTooltip(session);
        this.item.show();
        break;
      }
    }
  }

  private buildTooltip(session: ResolvedSession): vscode.MarkdownString {
    const ceilingTokens = Math.round(
      (session.autoCompactPct / 100) * session.contextWindowSize
    );
    const pctOfCeiling =
      ceilingTokens > 0
        ? Math.min(100, Math.round((session.contextUsed / ceilingTokens) * 100))
        : 0;
    const pctRemaining = Math.max(0, 100 - pctOfCeiling);

    const maxTitleLen = 38;
    const title = session.sessionTitle
      ? session.sessionTitle.length > maxTitleLen
        ? session.sessionTitle.slice(0, maxTitleLen) + "..."
        : session.sessionTitle
      : "";

    const bar = makeTokenBar(pctOfCeiling);

    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = false;
    md.appendMarkdown(`**Claude session token context**  \n`);
    if (title) {
      md.appendMarkdown(`"${title}"  \n`);
    }
    md.appendMarkdown(
      `📁 ${session.label} ${formatTokens(session.contextUsed)} / ${formatTokens(ceilingTokens)}\n\n`
    );
    md.appendMarkdown(`${bar} ${formatPct(pctOfCeiling)} used\n\n`);
    md.appendMarkdown(
      `🗜️ Auto-compact at ${formatTokens(ceilingTokens)} · ${formatPct(pctRemaining)} remaining`
    );
    return md;
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
