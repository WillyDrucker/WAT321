import * as vscode from "vscode";
import { getDisplayMode } from "../../engine/displayMode";
import { renderClaudeBar } from "../ui/heatmap";
import { formatFiveHourReset, formatWeeklyReset } from "../ui/resetFormatters";
import { buildUsageTooltipHtml } from "../ui/usageTooltipHtml";
import { getMaxLabel } from "./formatters";
import type { UsageResponse } from "./types";

/** Claude full-mode bar color ramp (used-percent based). */
function claudeBarColor(usedPct: number): string {
  if (usedPct >= 80) return "#ef4444";
  if (usedPct >= 50) return "#f59e0b";
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
    md.appendMarkdown(`**Current session (5hr)** ${sPct}% used  \n`);
    md.appendMarkdown(`${renderClaudeBar(sPct, 10)}  \n`);
    md.appendMarkdown(`\u{29D7} ${sReset}\n\n`);
    md.appendMarkdown(`**Weekly limits** ${wPct}% used  \n`);
    md.appendMarkdown(`${renderClaudeBar(wPct, 10)}  \n`);
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
        valueLabel: `${sPct}% used`,
        barFillPct: sPct,
        barColor: claudeBarColor(sPct),
        resetLine: sReset,
      },
      {
        title: "Weekly limits",
        valueLabel: `${wPct}% used`,
        barFillPct: wPct,
        barColor: claudeBarColor(wPct),
        resetLine: wReset,
      },
    ],
  });
}
