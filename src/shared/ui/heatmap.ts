import * as vscode from "vscode";
import { SETTING } from "../../engine/settingsKeys";
import { makeBar as makeClaudeBarDefault } from "../claude-usage/formatters";
import { makeBar as makeCodexBarDefault } from "../codex-usage/formatters";

/**
 * Heatmap coloring for WAT321 usage progress bars. Two models:
 *
 *   - **Codex (band-based):** single color for the filled portion,
 *     shifts green -> yellow -> red as remaining capacity drops.
 *   - **Claude (rolling):** per-cell coloring. Cells past 55% turn
 *     yellow, past 85% turn red. Yellow demotes to blue in red phase.
 *
 * Gated on `wat321.enableHeatmap` (default on). `renderClaudeBar` and
 * `renderCodexBar` are the dispatch points for all rendering surfaces.
 *
 * Color thresholds: Codex bands (25/50) sourced from the ChatGPT
 * usage dashboard (Tailwind green-500 / red-400). Claude thresholds
 * (55/85) align with natural cell crossovers in 10-wide and 5-wide
 * bars.
 */

/** Large blue square emoji. U+1F7E6 LARGE BLUE SQUARE. */
const SQUARE_BLUE = "\uD83D\uDFE6";
/** Large green square emoji. U+1F7E9 LARGE GREEN SQUARE. */
const SQUARE_GREEN = "\uD83D\uDFE9";
/** Large yellow square emoji. U+1F7E8 LARGE YELLOW SQUARE. */
const SQUARE_YELLOW = "\uD83D\uDFE8";
/** Large red square emoji. U+1F7E5 LARGE RED SQUARE. */
const SQUARE_RED = "\uD83D\uDFE5";
/** Large black square emoji. U+2B1B BLACK LARGE SQUARE. */
const SQUARE_BLACK = "\u2B1B";

export type HeatmapBand = "green" | "yellow" | "red";

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

/** Classify a Codex "remaining" percentage (100 = full, 0 = depleted)
 * into a heatmap band. Used by Codex widgets which report remaining
 * capacity from the rate limit API. The gating on
 * `wat321.enableHeatmap` happens one level up in `renderCodexBar`;
 * this classifier is always safe to call.
 *
 *   remaining > 50%      -> green  (plenty of room)
 *   remaining 25%-50%    -> yellow (more than half consumed)
 *   remaining <= 25%     -> red    (approaching depletion)
 */
export function bandFromRemaining(remainingPct: number): HeatmapBand {
  if (remainingPct <= 25) return "red";
  if (remainingPct <= 50) return "yellow";
  return "green";
}

/** Return the emoji fill character for a band. Used internally by
 * `buildCodexHeatmapBar` and exposed for widgets that need the raw
 * color mapping. */
export function fillCharForBand(band: HeatmapBand): string {
  switch (band) {
    case "green":
      return SQUARE_GREEN;
    case "yellow":
      return SQUARE_YELLOW;
    case "red":
      return SQUARE_RED;
  }
}

/** Build a Codex band-based heatmap progress bar.
 *
 * Codex's bar fills right-to-left as capacity drops, so a single
 * band color applied to the whole filled portion is the right
 * model: the bar "shrinks from green into black" and the filled
 * cells shift color as the user crosses band thresholds. Unlike the
 * Claude heatmap this does not need a per-cell rolling rule.
 *
 * Two edge cases get special treatment here so the bar always
 * communicates its state honestly:
 *
 *   1. **Minimum red cell**. At very low remaining (0-4% for a
 *      10-wide bar, 0-9% for 5-wide) the rounded fill count is
 *      zero, so a pure `round()` produces an all-black bar - which
 *      reads as "no data" rather than "almost depleted". The band
 *      is correctly classified as red, but the visual is empty.
 *      The helper forces the fill count to at least one cell when
 *      in the red band so the critical state is always visible.
 *
 *   2. **Fully depleted override**. At exactly 0% remaining (100%
 *      used) every cell renders red. This mirrors the Claude 100%
 *      override and makes "maxed out" unmistakable even though the
 *      metaphor of "filling from the right" would otherwise leave
 *      the bar empty. */
export function buildCodexHeatmapBar(
  usedPct: number,
  width: number
): string {
  const clamped = Math.max(0, Math.min(100, usedPct));
  const remainingPct = Math.max(0, 100 - clamped);

  // Fully depleted override: every cell red so "maxed out" is
  // unmistakable regardless of the right-to-left fill metaphor.
  if (remainingPct <= 0) {
    return SQUARE_RED.repeat(width);
  }

  const band = bandFromRemaining(remainingPct);
  const fillChar = fillCharForBand(band);

  let filled = Math.round((remainingPct / 100) * width);
  // Minimum-one-cell guarantee when in the red band so the visual
  // never lies by going empty at very low remaining.
  if (band === "red" && filled < 1) {
    filled = 1;
  }
  filled = Math.min(filled, width);
  const empty = width - filled;
  return fillChar.repeat(filled) + SQUARE_BLACK.repeat(empty);
}

/** Usage percentage at which the yellow band becomes active. Constant
 * across all bar widths. Cell 6 lights up exactly at this threshold
 * in a 10-wide bar; in a 5-wide bar cell 3 is already lit from pct=50
 * and upgrades in place from blue to yellow. */
const CLAUDE_YELLOW_THRESHOLD = 55;
/** Usage percentage at which the red band becomes active. Constant
 * across all bar widths. Cell 9 lights up exactly at this threshold
 * in a 10-wide bar; in a 5-wide bar cell 4 is already lit from pct=70
 * and upgrades in place from yellow to red. */
const CLAUDE_RED_THRESHOLD = 85;

/** Build a Claude "rolling" heatmap progress bar with per-cell
 * coloring.
 *
 * Unlike the Codex heatmap which picks a single band color for the
 * whole filled portion, the Claude heatmap is position-aware: cells
 * past a configurable position are colored, cells below stay blue.
 * The active phase (blue / yellow / red) is driven by constant
 * percent thresholds (55 and 85) that don't depend on width, and the
 * "first colored cell" position is derived from the fill count at
 * those thresholds. This keeps the model aligned with the natural
 * cell crossovers of the default progress bar in both 10-wide and
 * 5-wide renderings without ever bumping the fill count.
 *
 * Rules (usedPct is the Claude utilization percentage, 0-100):
 *
 *   usedPct  <  55       blue phase   all filled cells blue
 *   55 <= usedPct <  85  yellow phase cells from firstYellowCell up
 *                                     to the current fill are yellow;
 *                                     cells below are blue
 *   85 <= usedPct <  100 red phase    cells from firstRedCell up to
 *                                     the current fill are red; cells
 *                                     below are blue (any previously
 *                                     yellow cell in that range
 *                                     "demotes" back to blue)
 *   usedPct  == 100      override     every cell is red
 *
 * In a 10-wide bar firstYellowCell=6 and firstRedCell=9, so the
 * yellow band is cells 6-8 and the red band is cells 9-10 with no
 * overlap. In a 5-wide bar firstYellowCell=3 and firstRedCell=4, so
 * cell 4 is yellow during 70-84 and upgrades in place to red at 85;
 * the yellow and red bands share cell 4. That sharing is what lets
 * the compact bar avoid a dead zone after the 85% threshold without
 * needing any rounding hacks. */
export function buildClaudeHeatmapBar(
  usedPct: number,
  width: number
): string {
  const clamped = Math.max(0, Math.min(100, usedPct));

  // At exactly 100 (or any clamped-to-100 value), every cell is red.
  // This is a hard override on top of the normal phase rules so the
  // saturation state is unmistakable.
  if (clamped >= 100) {
    return SQUARE_RED.repeat(width);
  }

  const filled = Math.round((clamped / 100) * width);
  const firstYellowCell = Math.round(
    (CLAUDE_YELLOW_THRESHOLD / 100) * width
  );
  const firstRedCell = Math.round((CLAUDE_RED_THRESHOLD / 100) * width);

  const cells: string[] = [];
  for (let i = 0; i < width; i++) {
    if (i >= filled) {
      cells.push(SQUARE_BLACK);
      continue;
    }
    const cellPos = i + 1; // 1-indexed to match firstYellowCell/firstRedCell
    if (clamped >= CLAUDE_RED_THRESHOLD && cellPos >= firstRedCell) {
      cells.push(SQUARE_RED);
    } else if (
      clamped >= CLAUDE_YELLOW_THRESHOLD &&
      clamped < CLAUDE_RED_THRESHOLD &&
      cellPos >= firstYellowCell
    ) {
      cells.push(SQUARE_YELLOW);
    } else {
      cells.push(SQUARE_BLUE);
    }
  }
  return cells.join("");
}

/** Render a Claude usage progress bar at the requested width,
 * respecting the `wat321.enableHeatmap` setting. Returns the rolling
 * per-cell heatmap bar when on, or the default solid-blue bar when
 * off. Shared by status bar widgets and tooltip builders. */
export function renderClaudeBar(
  usedPct: number,
  width: number = 10
): string {
  if (isHeatmapEnabled()) {
    return buildClaudeHeatmapBar(usedPct, width);
  }
  return makeClaudeBarDefault(usedPct, width);
}

/** Render a Codex usage progress bar at the requested width,
 * respecting the `wat321.enableHeatmap` setting. Returns the
 * band-based heatmap bar when on, or the default solid-green bar
 * when off. Shared by status bar widgets and tooltip builders. */
export function renderCodexBar(
  usedPct: number,
  width: number = 10
): string {
  if (isHeatmapEnabled()) {
    return buildCodexHeatmapBar(usedPct, width);
  }
  return makeCodexBarDefault(usedPct, width);
}

