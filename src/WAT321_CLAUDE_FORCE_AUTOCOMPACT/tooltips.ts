import * as vscode from "vscode";
import { formatPct, formatTokens } from "../shared/ui/tokenFormatters";

/**
 * MarkdownString builders for each Claude Force Auto-Compact widget
 * state. Pure functions - take the minimum data the tooltip needs and
 * produce a ready-to-assign `vscode.MarkdownString`.
 */

export interface LiveSessionTooltipInput {
  label: string;
  sessionTitle: string;
  contextUsed: number;
  contextWindowSize: number;
  autoCompactPct: number;
}

const MAX_TITLE_LEN = 38;

/** Truncate a session title for display. Returns "" for empty input. */
export function truncateTitle(raw: string): string {
  if (!raw) return "";
  return raw.length > MAX_TITLE_LEN ? raw.slice(0, MAX_TITLE_LEN) + "..." : raw;
}

/** Tooltip for the idle "ready" state. Shows context usage if a live
 * Claude session is available, otherwise tells the user to open Claude
 * Code first. */
export function buildReadyTooltip(
  live: LiveSessionTooltipInput | null
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportHtml = false;
  md.appendMarkdown("**Claude Force Auto-Compact**  \n");

  if (live) {
    const title = truncateTitle(live.sessionTitle);
    if (title) md.appendMarkdown(`"${title}"  \n`);
    const ceiling = Math.round(
      (live.autoCompactPct / 100) * live.contextWindowSize
    );
    const pct = ceiling > 0 ? Math.round((live.contextUsed / ceiling) * 100) : 0;
    md.appendMarkdown(
      `📁 ${live.label} ${formatTokens(live.contextUsed)} / ${formatTokens(ceiling)} (${formatPct(pct)})\n\n`
    );
    md.appendMarkdown("Click to trigger Claude's **auto-compact** on your next prompt.  \n");
    md.appendMarkdown(
      "Higher-quality summary than `/compact` - preserves tool results and reasoning."
    );
  } else {
    md.appendMarkdown("No live Claude session in this workspace.  \n\n");
    md.appendMarkdown(
      "Open Claude Code and send a prompt to establish a live session, then click to arm."
    );
  }

  return md;
}

/** Tooltip for the "armed" state. Title is the only context; the body
 * is a single bold disarm CTA. Session info, armed-duration, and
 * prompt-the-target guidance were deliberately dropped in favor of a
 * one-line, one-action tooltip. */
export function buildArmedTooltip(): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportHtml = false;
  md.appendMarkdown("\u2757 Claude Force Auto-Compact - Armed  \n\n");
  md.appendMarkdown("**Click here to disarm and restore your setting right away.**");
  return md;
}

/** Tooltip for the "stale-sentinel" error recovery state. */
export function buildStaleTooltip(): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportHtml = false;
  md.appendMarkdown("**Claude Force Auto-Compact - Needs Attention**  \n");
  md.appendMarkdown(
    "A leftover sentinel from a previous session could not be restored automatically.  \n\n"
  );
  md.appendMarkdown("Click to retry the restore.");
  return md;
}
