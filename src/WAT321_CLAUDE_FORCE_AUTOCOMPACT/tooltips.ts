import * as vscode from "vscode";
import { formatPct, formatTokens } from "../shared/ui/tokenFormatters";
import { USEFUL_CONTEXT_FRACTION } from "./constants";
import type { UnavailableReason } from "./types";

const FOLDER = "\u{1F4C1}"; // U+1F4C1 FILE FOLDER
const CLAMP = "\u{1F5DC}\u{FE0F}"; // U+1F5DC CLAMP + VS16

/**
 * MarkdownString builders for each Claude Force Auto-Compact widget
 * state. Pure functions - take the minimum data the tooltip needs
 * and produce a ready-to-assign `vscode.MarkdownString`.
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
  return raw.length > MAX_TITLE_LEN ? `${raw.slice(0, MAX_TITLE_LEN)}...` : raw;
}

/** Tooltip for the idle "ready" state. Shows session title and
 * context usage when a live Claude session exists, otherwise
 * tells the user to open Claude Code first. */
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
      `${FOLDER} ${live.label} ${formatTokens(live.contextUsed)} / ${formatTokens(ceiling)} (${formatPct(pct)})\n\n`
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

/** Tooltip for the "armed" state. Title is the only context; the
 * body is a single bold disarm CTA. */
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

/** Optional context info for the `below-useful-threshold` tooltip.
 * Lets the tooltip show the user exactly where they are, where the
 * button activates, and where Claude's native auto-compact will
 * fire on its own. */
export interface UnavailableContextInput {
  contextUsed: number;
  ceiling: number;
  fraction: number;
}

/** Tooltip for the "unavailable" paused state. The widget is
 * grayed and either hover-only or click-to-repair depending on
 * the reason. Each reason gets its own short explanation and
 * (for actionable reasons) a recovery hint. The exact command
 * title "WAT321: Reset All Settings" matches the contributed
 * command so users who copy the hint into the command palette
 * hit the right entry. */
export function buildUnavailableTooltip(
  reason: UnavailableReason,
  context: UnavailableContextInput | null = null
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportHtml = false;
  md.appendMarkdown("**Claude Force Auto-Compact - Paused**  \n\n");

  switch (reason) {
    case "below-useful-threshold": {
      if (context) {
        const activationTokens = Math.round(
          context.ceiling * USEFUL_CONTEXT_FRACTION
        );
        const currentPct = Math.round(context.fraction * 100);
        const activationPct = Math.round(USEFUL_CONTEXT_FRACTION * 100);
        md.appendMarkdown(
          `Your context is at **${formatTokens(context.contextUsed)} / ${formatTokens(context.ceiling)}** (${formatPct(currentPct)}).  \n\n`
        );
        md.appendMarkdown(
          `This button activates at **${formatTokens(activationTokens)}** (${activationPct}% of ceiling) so you do not compact a nearly-empty session.  \n\n`
        );
        md.appendMarkdown(
          `${CLAMP} Claude will auto-compact on its own at **${formatTokens(context.ceiling)}** (100%).`
        );
      } else {
        md.appendMarkdown(
          "Not enough context in this session to compact yet."
        );
      }
      break;
    }

    case "claude-busy":
      md.appendMarkdown(
        "Claude is currently working on a prompt or tool call.  \n\n"
      );
      md.appendMarkdown(
        "The button will light up on its own as soon as Claude is idle. Arming mid-turn could compact on a queued prompt instead of the one you intend."
      );
      break;

    case "loop-suspected":
      md.appendMarkdown(
        "Claude is auto-compacting repeatedly. Arming again would likely make things worse.  \n\n"
      );
      md.appendMarkdown(
        "Investigate what is driving the repeated compacts, or run **WAT321: Reset All Settings** in settings to return to a known-good state."
      );
      break;

    case "settings-stuck-at-armed":
      md.appendMarkdown(
        "`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is stuck at the WAT321 armed value in `~/.claude/settings.json`.  \n\n"
      );
      md.appendMarkdown(
        "WAT321 tried to auto-repair this and something overwrote the value. **Click to retry the repair now**, or run **WAT321: Reset All Settings** in settings if the problem keeps coming back."
      );
      break;

    case "settings-missing":
      md.appendMarkdown(
        "`~/.claude/settings.json` is missing. Claude Force Auto-Compact needs an existing Claude settings file.  \n\n"
      );
      md.appendMarkdown(
        "Launch Claude Code once so it creates the file, then the widget will light back up on its own."
      );
      break;

    case "settings-io-error":
      md.appendMarkdown(
        "WAT321 could not read `~/.claude/settings.json`.  \n\n"
      );
      md.appendMarkdown(
        "Check that the file is not locked, corrupted, or protected by file permissions. **Click to retry** once the file is accessible, or run **WAT321: Reset All Settings** in settings if the problem persists."
      );
      break;

    case "sentinel-exists-external":
      md.appendMarkdown(
        "Another WAT321 instance currently has an arm in flight.  \n\n"
      );
      md.appendMarkdown(
        "The widget will light back up automatically once the other instance disarms. Run **WAT321: Reset All Settings** in settings if the other instance appears stuck."
      );
      break;
  }

  return md;
}
