import * as vscode from "vscode";
import { SETTING } from "../../engine/settingsKeys";
import { getRemainingPct } from "../codexUsage/codexUsageFormatters";
import {
  buildClaudeHeatmapBar,
  buildClaudeRemainingHeatmapBar,
} from "./claudeHeatmapBar";
import { buildCodexHeatmapBar, buildCodexUsedHeatmapBar } from "./codexHeatmapBar";
import { SQUARE_BLUE, SQUARE_GREEN } from "./heatmapPalette";
import { makeProgressBar } from "./progressBar";
import type { UsageStyle } from "./usageDisplay";

/**
 * The dispatch point for every usage bar, on the status bar and in the
 * tooltips. With the heatmap on, an ascending (used) bar colors cell by
 * cell so a warning reads as an accent, and a descending (remaining) bar
 * colors its whole fill by band, because a draining fill is only a few
 * cells by the time a gate hits. Each provider's gates live in its own
 * bar module. With the heatmap off, every bar is a plain provider fill.
 */

/** Is `wat321.enableHeatmap` on? Gates every heatmap coloring, bars and
 * text alike. Read fresh on every call so a toggle applies at once. */
export function isHeatmapEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("wat321")
    .get<boolean>(SETTING.enableHeatmap, true);
}

/** A Claude usage bar `width` cells wide in the given style, defaulting
 * to Claude's native used style. */
export function renderClaudeBar(
  usedPct: number,
  width: number = 10,
  style: UsageStyle = "used"
): string {
  const remaining = style === "remaining";
  if (isHeatmapEnabled()) {
    return remaining
      ? buildClaudeRemainingHeatmapBar(usedPct, width)
      : buildClaudeHeatmapBar(usedPct, width);
  }
  const fillPct = remaining ? 100 - Math.max(0, Math.min(100, usedPct)) : usedPct;
  return makeProgressBar(fillPct, width, SQUARE_BLUE);
}

/** A Codex usage bar `width` cells wide in the given style, defaulting
 * to Codex's native remaining style, which reads through the same 1%
 * floor as the widget percent. */
export function renderCodexBar(
  usedPct: number,
  width: number = 10,
  style: UsageStyle = "remaining"
): string {
  const used = style === "used";
  if (isHeatmapEnabled()) {
    return used
      ? buildCodexUsedHeatmapBar(usedPct, width)
      : buildCodexHeatmapBar(usedPct, width);
  }
  return makeProgressBar(used ? usedPct : getRemainingPct(usedPct), width, SQUARE_GREEN);
}
