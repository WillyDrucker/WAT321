import * as vscode from "vscode";
import { getDisplayMode } from "../../engine/displayMode";
import { bandFromRemaining, renderCodexBar } from "../ui/heatmap";
import { formatFiveHourReset, formatWeeklyReset } from "../ui/resetFormatters";
import { resolveUsageStyle } from "../ui/usageDisplay";
import { buildUsageTooltipHtml } from "../ui/usageTooltipHtml";
import { formatPlanLabel, getRemainingPct } from "./formatters";
import type { CodexUsageResponse } from "./types";

/** Codex full-mode bar color, derived from the same remaining bands
 * as the status-bar heatmap so hover and widget always agree. */
function codexBarColor(remainingPct: number): string {
  const band = bandFromRemaining(remainingPct);
  if (band === "red") return "#ef4444";
  if (band === "yellow") return "#f59e0b";
  return "#22c55e";
}

export function buildTooltip(usage: CodexUsageResponse): vscode.MarkdownString {
  const sPct = usage.rate_limit?.primary_window?.used_percent ?? 0;
  const sRemaining = getRemainingPct(sPct);
  const sReset = usage.rate_limit?.primary_window
    ? formatFiveHourReset(usage.rate_limit.primary_window.reset_at * 1000)
    : "Resets unknown";
  const wPct = usage.rate_limit?.secondary_window?.used_percent ?? 0;
  const wRemaining = getRemainingPct(wPct);
  const wReset = usage.rate_limit?.secondary_window
    ? formatWeeklyReset(usage.rate_limit.secondary_window.reset_at * 1000)
    : "Resets unknown";
  const planLabel = formatPlanLabel(usage.plan_type);
  // Tooltip percents, labels, and embedded bars follow the same
  // usage style as the status bar so the hover never contradicts
  // the widget next to it. Color ramps stay keyed to remaining
  // percent.
  const style = resolveUsageStyle("codex");
  const showUsed = style === "used";
  const pctLabel = showUsed ? "used" : "remaining";
  const sShown = showUsed ? 100 - sRemaining : sRemaining;
  const wShown = showUsed ? 100 - wRemaining : wRemaining;

  let creditsText = "";
  if (usage.credits?.has_credits || usage.credits?.unlimited) {
    const balance = usage.credits.unlimited
      ? "Unlimited"
      : `$${usage.credits.balance ?? "0"}`;
    creditsText = `Credits: ${balance}`;
  }

  if (getDisplayMode() === "minimal") {
    // Minimal tooltip uses emoji bars so heatmap rules stay uniform
    // with the status bar surface.
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    // HTML needed for `&nbsp;` to render as non-breaking space (plain
    // whitespace collapses in markdown). Theme icons needed so
    // `$(openai)` renders the brand codicon.
    md.supportHtml = true;
    md.supportThemeIcons = true;
    md.appendMarkdown(
      `$(openai)&nbsp;&nbsp;**Codex usage limits** ${planLabel}\n\n`
    );
    md.appendMarkdown(`**5 hour usage limit** ${sShown}% ${pctLabel}  \n`);
    md.appendMarkdown(`${renderCodexBar(sPct, 10, style)}  \n`);
    md.appendMarkdown(`\u{29D7} ${sReset}\n\n`);
    md.appendMarkdown(`**Weekly usage limit** ${wShown}% ${pctLabel}  \n`);
    md.appendMarkdown(`${renderCodexBar(wPct, 10, style)}  \n`);
    md.appendMarkdown(`\u{29D7} ${wReset}\n\n`);
    if (creditsText) md.appendMarkdown(`${creditsText}\n\n`);
    md.appendMarkdown(`Updated ${new Date().toLocaleTimeString()}`);
    return md;
  }

  return buildUsageTooltipHtml({
    heading: "Codex usage limits",
    headingIcon: "$(openai)",
    planLabel,
    rows: [
      {
        title: "5 hour usage limit",
        valueLabel: `${sShown}% ${pctLabel}`,
        barFillPct: sShown,
        barColor: codexBarColor(sRemaining),
        resetLine: sReset,
      },
      {
        title: "Weekly usage limit",
        valueLabel: `${wShown}% ${pctLabel}`,
        barFillPct: wShown,
        barColor: codexBarColor(wRemaining),
        resetLine: wReset,
      },
    ],
    footer: creditsText || undefined,
  });
}
