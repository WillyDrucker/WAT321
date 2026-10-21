import type * as vscode from "vscode";
import { getDisplayMode } from "../../engine/displayMode";
import { bandFromRemaining } from "../ui/codexHeatmapBar";
import { renderCodexBar } from "../ui/heatmap";
import { AMBER_WARNING, CODEX_BRAND_GREEN, RED_CRITICAL } from "../ui/hexColors";
import { resolveUsageStyle } from "../ui/usageDisplay";
import { buildUsageTooltipHtml, buildUsageTooltipMinimal } from "../ui/usageTooltipShell";
import { formatPlanLabel, getRemainingPct } from "./codexUsageFormatters";
import type { CodexUsageResponse } from "./codexUsageTypes";
import { resolveCodexWindows, type CodexUsageRow } from "./codexUsageWindows";

/**
 * The Codex usage tooltip: whichever windows Codex currently publishes
 * in the shared shell, with percents, labels, and bars following the
 * same usage style as the status bar so the hover never contradicts
 * the widget next to it. Color ramps stay keyed to remaining percent.
 */

/** Full-mode bar color, derived from the same remaining bands as the
 * status-bar heatmap so hover and widget always agree. */
function codexBarColor(remainingPct: number): string {
  const band = bandFromRemaining(remainingPct);
  if (band === "red") return RED_CRITICAL;
  if (band === "yellow") return AMBER_WARNING;
  return CODEX_BRAND_GREEN;
}

/** Percent the row should display, honoring the user's usage style.
 * Kept beside the row so the bar, the label, and the color all read the
 * same window rather than each re-deriving it. */
function shownPct(row: CodexUsageRow, showUsed: boolean): number {
  const remaining = getRemainingPct(row.window.used_percent);
  return showUsed ? 100 - remaining : remaining;
}

export function buildTooltip(usage: CodexUsageResponse): vscode.MarkdownString {
  // Rows come from the resolved layout, so a window Codex no longer
  // publishes leaves no row behind. A fixed two-row layout would draw a
  // retired window as a full green bar over "Resets unknown" instead of
  // leaving it out.
  const layout = resolveCodexWindows(usage);
  const rows = [layout.primary, layout.secondary].filter(
    (r): r is CodexUsageRow => r !== null
  );

  const planLabel = formatPlanLabel(usage.plan_type);
  const style = resolveUsageStyle("codex");
  const showUsed = style === "used";
  const pctLabel = showUsed ? "used" : "remaining";

  // Footer notes, in order. The empty-rows note matters: `rate_limit` can
  // come back null, and both surfaces must then say so rather than one
  // reading "Usage data unavailable" while the other renders a heading
  // with nothing under it.
  const notes: string[] = [];
  if (rows.length === 0) notes.push("Usage data unavailable");
  if (usage.credits?.has_credits || usage.credits?.unlimited) {
    const balance = usage.credits.unlimited
      ? "Unlimited"
      : `$${usage.credits.balance ?? "0"}`;
    notes.push(`Credits: ${balance}`);
  }

  if (getDisplayMode() === "minimal") {
    return buildUsageTooltipMinimal({
      heading: "Codex usage limits",
      headingIcon: "$(openai)",
      planLabel,
      rows: rows.map((row) => ({
        title: row.title,
        valueLabel: `${shownPct(row, showUsed)}% ${pctLabel}`,
        bar: renderCodexBar(row.window.used_percent, 10, style),
        resetLine: row.resetLine,
      })),
      notes,
    });
  }

  return buildUsageTooltipHtml({
    heading: "Codex usage limits",
    headingIcon: "$(openai)",
    planLabel,
    rows: rows.map((row) => {
      const remaining = getRemainingPct(row.window.used_percent);
      const shown = shownPct(row, showUsed);
      return {
        title: row.title,
        valueLabel: `${shown}% ${pctLabel}`,
        barFillPct: shown,
        barColor: codexBarColor(remaining),
        resetLine: row.resetLine,
      };
    }),
    // `<br>` rather than a newline: the shell renders the footer as HTML.
    footer: notes.length > 0 ? notes.join("<br>") : undefined,
  });
}
