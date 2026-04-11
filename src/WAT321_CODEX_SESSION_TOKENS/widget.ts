import * as vscode from "vscode";
import type { CodexTokenWidgetState, CodexResolvedSession, StatusBarWidget } from "./types";
import { CodexSessionTokenService } from "./service";
import { formatTokens, formatPct, makeTokenBar } from "../shared/ui/tokenFormatters";
import { getDisplayMode } from "../shared/displayMode";
import { getWidgetPriority } from "../shared/priority";

export class CodexSessionTokensWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.codexSessionTokens",
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(5)
    );
    this.item.name = "WAT321: Codex Session Tokens";
    this.item.text = "🗜️ Codex -";
    this.item.tooltip = "No active Codex session";
    this.item.show();
  }

  update(state: CodexTokenWidgetState): void {
    switch (state.status) {
      case "no-session":
      case "waiting":
        this.item.text = "🗜️ Codex -";
        this.item.tooltip = "No active Codex session";
        this.item.color = undefined;
        this.item.show();
        break;

      case "ok": {
        const { session } = state;
        const usedPct = session.contextWindowSize > 0
          ? Math.min(100, Math.round((session.contextUsed / session.contextWindowSize) * 100))
          : 0;

        const mode = getDisplayMode();
        if (mode === "minimal" || mode === "compact") {
          this.item.text = `🗜️ Codex ${formatTokens(session.contextUsed)} ${formatPct(usedPct)}`;
        } else {
          this.item.text = `🗜️ Codex ${formatTokens(session.contextUsed)} / ${formatTokens(session.contextWindowSize)} ${formatPct(usedPct)}`;
        }

        this.item.color =
          usedPct >= 90
            ? new vscode.ThemeColor("statusBarItem.warningForeground")
            : undefined;

        this.item.tooltip = this.buildTooltip(session);
        this.item.show();
        break;
      }
    }
  }

  private buildTooltip(session: CodexResolvedSession): vscode.MarkdownString {
    const usedPct = session.contextWindowSize > 0
      ? Math.min(100, Math.round((session.contextUsed / session.contextWindowSize) * 100))
      : 0;
    const remainingPct = Math.max(0, 100 - usedPct);
    const bar = makeTokenBar(usedPct);

    const maxTitleLen = 38;
    const title = session.sessionTitle
      ? session.sessionTitle.length > maxTitleLen
        ? session.sessionTitle.slice(0, maxTitleLen) + "..."
        : session.sessionTitle
      : "";

    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = false;
    md.appendMarkdown(`**Codex session token context**  \n`);
    if (title) {
      md.appendMarkdown(`"${title}"  \n`);
    }
    md.appendMarkdown(
      `📁 ${session.label} ${formatTokens(session.contextUsed)} / ${formatTokens(session.contextWindowSize)}\n\n`
    );
    md.appendMarkdown(`${bar} ${formatPct(usedPct)} used\n\n`);
    md.appendMarkdown(
      `🗜️ Auto-compact at ${formatTokens(session.contextWindowSize)} · ${formatPct(remainingPct)} remaining`
    );
    return md;
  }

  dispose(): void {
    this.item.dispose();
  }
}

export function activateCodexTokenWidget(
  context: vscode.ExtensionContext,
  service: CodexSessionTokenService
): void {
  const widget = new CodexSessionTokensWidget();
  const listener = (state: CodexTokenWidgetState) => widget.update(state);
  service.subscribe(listener);

  context.subscriptions.push(widget, {
    dispose: () => service.unsubscribe(listener),
  });
}
