import * as vscode from "vscode";
import { getDisplayMode } from "../../engine/displayMode";
import { renderCodexBar } from "../ui/heatmap";
import { formatFiveHourReset, formatWeeklyReset } from "../ui/resetFormatters";
import { buildUsageTooltipHtml } from "../ui/usageTooltipHtml";
import { formatPlanLabel, getRemainingPct } from "./formatters";
import type { CodexUsageResponse } from "./types";

/** Codex full-mode bar color ramp (remaining-percent based, because
 * the bar shrinks from full as capacity depletes). */
function codexBarColor(remainingPct: number): string {
  if (remainingPct <= 20) return "#ef4444";
  if (remainingPct <= 50) return "#f59e0b";
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
    md.supportHtml = false;
    md.appendMarkdown(`**Codex usage limits** ${planLabel}\n\n`);
    md.appendMarkdown(`**5 hour usage limit** ${sRemaining}% remaining  \n`);
    md.appendMarkdown(`${renderCodexBar(sPct, 10)}  \n`);
    md.appendMarkdown(`\u{29D7} ${sReset}\n\n`);
    md.appendMarkdown(`**Weekly usage limit** ${wRemaining}% remaining  \n`);
    md.appendMarkdown(`${renderCodexBar(wPct, 10)}  \n`);
    md.appendMarkdown(`\u{29D7} ${wReset}\n\n`);
    if (creditsText) md.appendMarkdown(`${creditsText}\n\n`);
    md.appendMarkdown(`Updated ${new Date().toLocaleTimeString()}`);
    return md;
  }

  return buildUsageTooltipHtml({
    heading: "Codex usage limits",
    planLabel,
    rows: [
      {
        title: "5 hour usage limit",
        valueLabel: `${sRemaining}% remaining`,
        barFillPct: sRemaining,
        barColor: codexBarColor(sRemaining),
        resetLine: sReset,
      },
      {
        title: "Weekly usage limit",
        valueLabel: `${wRemaining}% remaining`,
        barFillPct: wRemaining,
        barColor: codexBarColor(wRemaining),
        resetLine: wReset,
      },
    ],
    footer: creditsText || undefined,
  });
}
