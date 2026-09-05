import * as vscode from "vscode";
import { SETTING } from "../../engine/settingsKeys";
import { makeBar as makeClaudeBarDefault } from "../claude-usage/formatters";
import { makeBar as makeCodexBarDefault } from "../codex-usage/formatters";
import {
  buildClaudeHeatmapBar,
  buildClaudeRemainingHeatmapBar,
} from "./claudeHeatmapBar";
import { buildCodexHeatmapBar, buildCodexUsedHeatmapBar } from "./codexHeatmapBar";
import { SQUARE_BLUE, SQUARE_GREEN } from "./heatmapPalette";
import { makeProgressBar } from "./progressBar";
import type { UsageStyle } from "./usageDisplay";

/**
 * Heatmap coloring for WAT321 usage progress bars. Two models,
 * picked by bar direction:
 *
 *   - **Ascending (rolling):** per-cell coloring - the backfill
 *     keeps the provider's base color and only cells past the
 *     thresholds turn yellow then red, so a warning reads as an
 *     accent, never a wall of color. Yellow demotes to base in the
 *     red phase. Claude gates at 70/85 used, Codex at 60/75 used
 *     (its native bands expressed on the used scale).
 *   - **Descending (band):** one color for the whole remaining
 *     fill - a draining fill is only a few cells by the time the
 *     gates hit, so per-cell positions degenerate. Codex gates at
 *     40/25 remaining, Claude at 30/15 remaining.
 *
 * The bars themselves live in `claudeHeatmapBar.ts` and
 * `codexHeatmapBar.ts`, the cells in `heatmapPalette.ts`. Gated on
 * `wat321.enableHeatmap` (default on). `renderClaudeBar` and
 * `renderCodexBar` are the dispatch points for all rendering surfaces.
 */

/** Is the heatmap feature enabled in user settings? Gates every
 * heatmap-related coloring in WAT321: Claude's rolling bar, Codex's
 * band-based bar, the Claude and Codex minimal-view brand text
 * colors, and the emoji-style bars inside the minimal tooltips.
 * Read fresh on every call so toggling the setting takes effect
 * immediately without a reload. */
export function isHeatmapEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("wat321")
    .get<boolean>(SETTING.enableHeatmap, true);
}

/** Render a Claude usage progress bar at the requested width,
 * respecting the `wat321.enableHeatmap` setting. Returns the rolling
 * per-cell heatmap bar when on, or the default solid-blue bar when
 * off. `style` follows `wat321.usageDisplay` - "used" (Claude's
 * native fill-up) is the default so existing call sites are
 * unchanged, "remaining" renders the draining variant. Shared by
 * status bar widgets and tooltip builders. */
export function renderClaudeBar(
  usedPct: number,
  width: number = 10,
  style: UsageStyle = "used"
): string {
  if (style === "remaining") {
    if (isHeatmapEnabled()) {
      return buildClaudeRemainingHeatmapBar(usedPct, width);
    }
    const remainingPct = 100 - Math.max(0, Math.min(100, usedPct));
    return makeProgressBar(remainingPct, width, SQUARE_BLUE);
  }
  if (isHeatmapEnabled()) {
    return buildClaudeHeatmapBar(usedPct, width);
  }
  return makeClaudeBarDefault(usedPct, width);
}

/** Render a Codex usage progress bar at the requested width,
 * respecting the `wat321.enableHeatmap` setting. Returns the
 * band-based heatmap bar when on, or the default solid-green bar
 * when off. `style` follows `wat321.usageDisplay` - "remaining"
 * (Codex's native count-down) is the default so existing call sites
 * are unchanged, "used" renders the fill-up variant. Shared by
 * status bar widgets and tooltip builders. */
export function renderCodexBar(
  usedPct: number,
  width: number = 10,
  style: UsageStyle = "remaining"
): string {
  if (style === "used") {
    if (isHeatmapEnabled()) {
      return buildCodexUsedHeatmapBar(usedPct, width);
    }
    return makeProgressBar(Math.max(0, Math.min(100, usedPct)), width, SQUARE_GREEN);
  }
  if (isHeatmapEnabled()) {
    return buildCodexHeatmapBar(usedPct, width);
  }
  return makeCodexBarDefault(usedPct, width);
}
