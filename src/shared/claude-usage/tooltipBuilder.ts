import * as vscode from "vscode";
import { getDisplayMode } from "../../engine/displayMode";
import {
  CLAUDE_RED_THRESHOLD,
  CLAUDE_YELLOW_THRESHOLD,
  renderClaudeBar,
} from "../ui/heatmap";
import { formatFiveHourReset, formatWeeklyReset } from "../ui/resetFormatters";
import { resolveUsageStyle } from "../ui/usageDisplay";
import { buildUsageTooltipHtml } from "../ui/usageTooltipHtml";
import { getMaxLabel } from "./formatters";
import type { UsageResponse } from "./types";

/** Claude full-mode bar color, keyed to the same used-percent gates
 * as the status-bar heatmap so hover and widget always agree. */
function claudeBarColor(usedPct: number): string {
  if (usedPct >= CLAUDE_RED_THRESHOLD) return "#ef4444";
  if (usedPct >= CLAUDE_YELLOW_THRESHOLD) return "#f59e0b";
  return "#3b82f6";
}

function isoToMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

export function buildTooltip(usage: UsageResponse): vscode.MarkdownString {
  const sPct = usage.five_hour?.utilization ?? 0;
  const sResetMs = isoToMs(usage.five_hour?.resets_at);
  const sReset = sResetMs !== null ? formatFiveHourReset(sResetMs) : "Resets unknown";
  const wPct = usage.seven_day?.utilization ?? 0;
  const wResetMs = isoToMs(usage.seven_day?.resets_at);
  const wReset = wResetMs !== null ? formatWeeklyReset(wResetMs) : "Resets unknown";
  const planLabel = getMaxLabel(usage.extra_usage);
  // Tooltip percents, labels, and embedded bars follow the same
  // usage style as the status bar so the hover never contradicts
  // the widget next to it. Color ramps stay keyed to used percent.
  const style = resolveUsageStyle("claude");
  const showRemaining = style === "remaining";
  const pctLabel = showRemaining ? "remaining" : "used";
  const sShown = showRemaining ? Math.max(0, 100 - sPct) : sPct;
  const wShown = showRemaining ? Math.max(0, 100 - wPct) : wPct;

  if (getDisplayMode() === "minimal") {
    // Minimal tooltip uses emoji bars so heatmap rules stay uniform
    // with the status bar surface.
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    // HTML needed for `&nbsp;` to render as non-breaking space (plain
    // whitespace collapses in markdown). Theme icons needed so
    // `$(claude)` renders the brand codicon.
    md.supportHtml = true;
    md.supportThemeIcons = true;
    md.appendMarkdown(
      `$(claude)&nbsp;&nbsp;**Claude usage limits** ${planLabel}\n\n`
    );
    md.appendMarkdown(`**Current session (5hr)** ${sShown}% ${pctLabel}  \n`);
    md.appendMarkdown(`${renderClaudeBar(sPct, 10, style)}  \n`);
    md.appendMarkdown(`\u{29D7} ${sReset}\n\n`);
    md.appendMarkdown(`**Weekly limits** ${wShown}% ${pctLabel}  \n`);
    md.appendMarkdown(`${renderClaudeBar(wPct, 10, style)}  \n`);
    md.appendMarkdown(`\u{29D7} ${wReset}\n\n`);
    md.appendMarkdown(`Updated ${new Date().toLocaleTimeString()}`);
    return md;
  }

  return buildUsageTooltipHtml({
    heading: "Claude usage limits",
    headingIcon: "$(claude)",
    planLabel,
    rows: [
      {
        title: "Current session (5hr)",
        valueLabel: `${sShown}% ${pctLabel}`,
        barFillPct: sShown,
        barColor: claudeBarColor(sPct),
        resetLine: sReset,
      },
      {
        title: "Weekly limits",
        valueLabel: `${wShown}% ${pctLabel}`,
        barFillPct: wShown,
        barColor: claudeBarColor(wPct),
        resetLine: wReset,
      },
    ],
  });
}
