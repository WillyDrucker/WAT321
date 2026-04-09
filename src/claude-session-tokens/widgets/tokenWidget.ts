import * as vscode from "vscode";
import type { WidgetState, ResolvedSession, StatusBarWidget } from "../types";
import { formatTokens, formatPct, makeTokenBar } from "../../shared/ui/tokenFormatters";
import { ClaudeSessionTokenService } from "../sessionService";
import { getDisplayMode } from "../../shared/displayMode";

export class ClaudeSessionTokensWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.sessionTokens",
      vscode.StatusBarAlignment.Right,
      997
    );
    this.item.name = "WAT321: Claude Session Tokens";
    this.item.text = "🗜️ Claude -";
    this.item.tooltip = "No active Claude session";
    this.item.show();
  }

  update(state: WidgetState): void {
    switch (state.status) {
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
            ? Math.round((session.contextUsed / ceilingTokens) * 100)
            : 0;

        const mode = getDisplayMode();
        if (mode === "minimal" || mode === "compact") {
          this.item.text = `🗜️ Claude ${formatTokens(session.contextUsed)} ${formatPct(pctOfCeiling)}`;
        } else {
          this.item.text = `🗜️ Claude ${formatTokens(session.contextUsed)} / ${formatTokens(ceilingTokens)} ${formatPct(pctOfCeiling)}`;
        }

        if (pctOfCeiling >= 100) {
          this.item.color = new vscode.ThemeColor(
            "statusBarItem.errorForeground"
          );
        } else if (pctOfCeiling >= 85) {
          this.item.color = new vscode.ThemeColor(
            "statusBarItem.warningForeground"
          );
        } else {
          this.item.color = undefined;
        }

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
        ? Math.round((session.contextUsed / ceilingTokens) * 100)
        : 0;
    const pctRemaining = Math.max(0, 100 - pctOfCeiling);

    // Truncate to roughly match the "Auto-compact at 700k · 75% remaining" line width
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
  context: vscode.ExtensionContext,
  service: ClaudeSessionTokenService
): void {
  const widget = new ClaudeSessionTokensWidget();
  const listener = (state: WidgetState) => widget.update(state);
  service.subscribe(listener);

  context.subscriptions.push(widget, {
    dispose: () => service.unsubscribe(listener),
  });
}
