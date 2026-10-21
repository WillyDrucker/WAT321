import type * as vscode from "vscode";
import { getDisplayMode } from "../../engine/displayMode";
import { CLAUDE_RED_THRESHOLD, CLAUDE_YELLOW_THRESHOLD } from "../ui/claudeHeatmapBar";
import { renderClaudeBar } from "../ui/heatmap";
import { AMBER_WARNING, CLAUDE_BAR_BLUE, RED_CRITICAL } from "../ui/hexColors";
import { formatFiveHourReset, formatWeeklyReset } from "../ui/resetFormatters";
import { resolveUsageStyle } from "../ui/usageDisplay";
import { buildUsageTooltipHtml, buildUsageTooltipMinimal } from "../ui/usageTooltipShell";
import { getMaxLabel } from "./claudeUsageFormatters";
import type { UsageResponse } from "./claudeUsageTypes";

/**
 * The Claude usage tooltip: the 5-hour and weekly windows in the
 * shared shell, with percents, labels, and bars following the same
 * usage style as the status bar so the hover never contradicts the
 * widget next to it. Color ramps stay keyed to used percent.
 */

/** Full-mode bar color, keyed to the same used-percent gates as the
 * status-bar heatmap so hover and widget always agree. */
function claudeBarColor(usedPct: number): string {
  if (usedPct >= CLAUDE_RED_THRESHOLD) return RED_CRITICAL;
  if (usedPct >= CLAUDE_YELLOW_THRESHOLD) return AMBER_WARNING;
  return CLAUDE_BAR_BLUE;
}

function isoToMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

function resetLine(ms: number | null, format: (ms: number) => string): string {
  return ms !== null ? format(ms) : "Resets unknown";
}

export function buildTooltip(usage: UsageResponse): vscode.MarkdownString {
  const planLabel = getMaxLabel(usage.extra_usage);
  const style = resolveUsageStyle("claude");
  const showRemaining = style === "remaining";
  const pctLabel = showRemaining ? "remaining" : "used";
  const rows = [
    {
      title: "Current session (5hr)",
      usedPct: usage.five_hour?.utilization ?? 0,
      resetLine: resetLine(isoToMs(usage.five_hour?.resets_at), formatFiveHourReset),
    },
    {
      title: "Weekly limits",
      usedPct: usage.seven_day?.utilization ?? 0,
      resetLine: resetLine(isoToMs(usage.seven_day?.resets_at), formatWeeklyReset),
    },
  ].map((row) => ({
    ...row,
    shown: showRemaining ? Math.max(0, 100 - row.usedPct) : row.usedPct,
  }));

  if (getDisplayMode() === "minimal") {
    return buildUsageTooltipMinimal({
      heading: "Claude usage limits",
      headingIcon: "$(claude)",
      planLabel,
      rows: rows.map((row) => ({
        title: row.title,
        valueLabel: `${row.shown}% ${pctLabel}`,
        bar: renderClaudeBar(row.usedPct, 10, style),
        resetLine: row.resetLine,
      })),
    });
  }

  return buildUsageTooltipHtml({
    heading: "Claude usage limits",
    headingIcon: "$(claude)",
    planLabel,
    rows: rows.map((row) => ({
      title: row.title,
      valueLabel: `${row.shown}% ${pctLabel}`,
      barFillPct: row.shown,
      barColor: claudeBarColor(row.usedPct),
      resetLine: row.resetLine,
    })),
  });
}
