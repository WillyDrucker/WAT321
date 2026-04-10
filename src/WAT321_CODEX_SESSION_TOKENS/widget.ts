import * as vscode from "vscode";
import type { CodexTokenWidgetState, CodexResolvedSession } from "./types";
import { CodexSessionTokenService } from "./service";

const BAR_WIDTH = 10;
const FILLED = "\uD83D\uDFE6"; // 🟦 — same blue as Claude for consistency
const EMPTY = "\u2B1B"; // ⬛

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = Math.round(tokens / 1_000);
    return `${k}k`;
  }
  return `${tokens}`;
}

function formatPct(pct: number): string {
  return `${Math.round(pct)}%`;
}

/** Blue bar showing used capacity (fills left to right) */
function makeBar(usedPct: number): string {
  const clamped = Math.max(0, Math.min(100, usedPct));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return FILLED.repeat(filled) + EMPTY.repeat(empty);
}

export class CodexSessionTokensWidget implements vscode.Disposable {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.codexSessionTokens",
      vscode.StatusBarAlignment.Right,
      996
    );
    this.item.name = "WAT321: Codex Session Tokens";
    this.item.hide();
  }

  update(state: CodexTokenWidgetState): void {
    switch (state.status) {
      case "no-session":
        this.item.hide();
        break;

      case "waiting":
        this.item.text = "$(loading~spin) Codex tokens";
        this.item.tooltip = "Waiting for Codex session data...";
        this.item.color = undefined;
        this.item.show();
        break;

      case "ok": {
        const { session } = state;
        const usedPct = Math.round(
          (session.contextUsed / session.contextWindowSize) * 100
        );

        this.item.text = `🗜️ Codex ${formatTokens(session.contextUsed)} / ${formatTokens(session.contextWindowSize)} ${formatPct(usedPct)}`;

        if (usedPct >= 100) {
          this.item.color = new vscode.ThemeColor(
            "statusBarItem.errorForeground"
          );
        } else if (usedPct >= 85) {
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

  private buildTooltip(session: CodexResolvedSession): vscode.MarkdownString {
    const usedPct = Math.round(
      (session.contextUsed / session.contextWindowSize) * 100
    );
    const remainingPct = Math.max(0, 100 - usedPct);
    const bar = makeBar(usedPct);

    const maxTitleLen = 38;
    const title = session.sessionTitle
      ? session.sessionTitle.length > maxTitleLen
        ? session.sessionTitle.slice(0, maxTitleLen) + "..."
        : session.sessionTitle
      : "";

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
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
