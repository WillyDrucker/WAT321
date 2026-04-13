import * as vscode from "vscode";
import { formatPct, formatTokens, makeTokenBar } from "./tokenFormatters";
import { formatRelativeTime } from "./relativeTime";

/**
 * Shared tooltip builder for the Claude and Codex session token
 * widgets. Both widgets surface the same information (provider,
 * optional session title, workspace label, current / ceiling token
 * count, progress bar, auto-compact threshold) - only the provider
 * name differs. Factoring the markdown build keeps the two widgets
 * thin and guarantees they stay visually consistent.
 */

const FOLDER = "\u{1F4C1}";
const CLAMP = "\u{1F5DC}\u{FE0F}";
const MAX_TITLE_LEN = 38;

export interface SessionTokenTooltipInput {
  provider: "Claude" | "Codex";
  sessionTitle: string;
  label: string;
  contextUsed: number;
  ceiling: number;
  /** Present on a `lastKnown` session, absent on a live session.
   * When present, the tooltip adds a "Last active: X ago" line so
   * the user knows they are looking at a snapshot. */
  lastActiveAt?: number;
}

export function buildSessionTokenTooltip(
  input: SessionTokenTooltipInput
): vscode.MarkdownString {
  const { provider, sessionTitle, label, contextUsed, ceiling, lastActiveAt } =
    input;

  const pctUsed =
    ceiling > 0
      ? Math.min(100, Math.round((contextUsed / ceiling) * 100))
      : 0;
  const pctRemaining = Math.max(0, 100 - pctUsed);
  const bar = makeTokenBar(pctUsed);

  const title =
    sessionTitle && sessionTitle.length > MAX_TITLE_LEN
      ? sessionTitle.slice(0, MAX_TITLE_LEN) + "..."
      : sessionTitle;

  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportHtml = false;
  md.appendMarkdown(`**${provider} session token context**  \n`);
  if (title) {
    md.appendMarkdown(`"${title}"  \n`);
  }
  if (typeof lastActiveAt === "number") {
    md.appendMarkdown(`Last active: ${formatRelativeTime(lastActiveAt)}  \n`);
  }
  md.appendMarkdown(
    `${FOLDER} ${label} ${formatTokens(contextUsed)} / ${formatTokens(ceiling)}\n\n`
  );
  md.appendMarkdown(`${bar} ${formatPct(pctUsed)} used\n\n`);
  md.appendMarkdown(
    `${CLAMP} Auto-compact at ${formatTokens(ceiling)} - ${formatPct(pctRemaining)} remaining`
  );
  return md;
}
