import * as vscode from "vscode";
import type {
  CodexResolvedSession,
  CodexTokenWidgetState,
  StatusBarWidget,
} from "./types";
import { CodexSessionTokenService } from "./service";
import { formatPct, formatTokens, makeTokenBar } from "../shared/ui/tokenFormatters";
import { getDisplayMode } from "../shared/displayMode";
import { getWidgetPriority } from "../shared/priority";

const CLAMP = "\u{1F5DC}\u{FE0F}";
const THOUGHT = "\u{1F4AD}";
const FOLDER = "\u{1F4C1}";

export class CodexSessionTokensWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "wat321.codexSessionTokens",
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(6)
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

        this.item.tooltip = this.buildTooltip(session);
        this.item.show();
        break;
      }
    }
  }

  private buildTooltip(session: CodexResolvedSession): vscode.MarkdownString {
    const usedPct = session.autoCompactTokens > 0
      ? Math.min(100, Math.round((session.contextUsed / session.autoCompactTokens) * 100))
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
    md.appendMarkdown("**Codex session token context**  \n");
    if (title) {
      md.appendMarkdown(`"${title}"  \n`);
    }
    md.appendMarkdown(
      `${FOLDER} ${session.label} ${formatTokens(session.contextUsed)} / ` +
      `${formatTokens(session.autoCompactTokens)}\n\n`
    );
    md.appendMarkdown(`${bar} ${formatPct(usedPct)} used\n\n`);
    md.appendMarkdown(
      `${CLAMP} Auto-compact at ${formatTokens(session.autoCompactTokens)} ` +
      `- ${formatPct(remainingPct)} remaining`
    );
    return md;
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
