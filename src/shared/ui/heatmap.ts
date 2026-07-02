import * as vscode from "vscode";
import { SETTING } from "../../engine/settingsKeys";
import { makeBar as makeClaudeBarDefault } from "../claude-usage/formatters";
import { makeBar as makeCodexBarDefault } from "../codex-usage/formatters";
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
 * Gated on `wat321.enableHeatmap` (default on). `renderClaudeBar` and
 * `renderCodexBar` are the dispatch points for all rendering surfaces.
 *
 * Color thresholds: Codex bands (25/40) sourced from the ChatGPT
 * usage dashboard (Tailwind green-500 / red-400). Claude thresholds
 * (70/85) align with natural cell crossovers in 10-wide and 5-wide
 * bars.
 */

/** Large blue square emoji. U+1F7E6 LARGE BLUE SQUARE. */
const SQUARE_BLUE = "\uD83D\uDFE6";
/** Large green square emoji. U+1F7E9 LARGE GREEN SQUARE. */
const SQUARE_GREEN = "\uD83D\uDFE9";
/** Large yellow square emoji. U+1F7E8 LARGE YELLOW SQUARE. */
const SQUARE_YELLOW = "\uD83D\uDFE8";
/** Large orange square emoji. U+1F7E7 LARGE ORANGE SQUARE. Used by
 * the Claude compact-progress bar. Not a heatmap band - compact is a
 * distinct widget state, not a usage severity. Exported via
 * `SQUARE_ORANGE_COMPACT` so the session-token widget can build its
 * own bar without depending on the heatmap rendering paths. */
const SQUARE_ORANGE = "\uD83D\uDFE7";
export const SQUARE_ORANGE_COMPACT = SQUARE_ORANGE;
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

/** Codex heatmap thresholds, defined on remaining capacity (sourced
 * from the ChatGPT usage dashboard). The used-direction rolling bar
 * derives its cell gates from these same values expressed on the
 * used scale (yellow at 60% used, red at 75%), so both directions
 * always agree on the moment severity starts. */
const CODEX_YELLOW_REMAINING_THRESHOLD = 40;
const CODEX_RED_REMAINING_THRESHOLD = 25;

/** Classify a Codex "remaining" percentage (100 = full, 0 = depleted)
 * into a heatmap band. Used by Codex widgets which report remaining
 * capacity from the rate limit API. The gating on
 * `wat321.enableHeatmap` happens one level up in `renderCodexBar` -
 * this classifier is always safe to call.
 *
 *   remaining > 40%      -> green  (plenty of room)
 *   remaining 25%-40%    -> yellow (past 60% used)
 *   remaining <= 25%     -> red    (approaching depletion)
 */
export function bandFromRemaining(remainingPct: number): HeatmapBand {
  if (remainingPct <= CODEX_RED_REMAINING_THRESHOLD) return "red";
  if (remainingPct <= CODEX_YELLOW_REMAINING_THRESHOLD) return "yellow";
  return "green";
}

/** Return the emoji fill character for a band. Internal to the
 * Codex bar builders. */
function fillCharForBand(band: HeatmapBand): string {
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
 *      used) every cell renders black - the bar represents what is
 *      left, so a fully empty bar is the honest reading of "nothing
 *      left". The used-direction bars own the all-red treatment. */
function buildCodexHeatmapBar(usedPct: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, usedPct));
  const remainingPct = Math.max(0, 100 - clamped);

  // Fully depleted: all black. The bar represents remaining capacity
  // so an empty bar correctly communicates "nothing left."
  if (remainingPct <= 0) {
    return SQUARE_BLACK.repeat(width);
  }

  const band = bandFromRemaining(remainingPct);
  const fillChar = fillCharForBand(band);

  let filled = Math.round((remainingPct / 100) * width);
  // Minimum-one-cell guarantee when in the red band so the visual
  // shows "almost depleted" instead of going empty at 1-4%.
  if (band === "red" && filled < 1) {
    filled = 1;
  }
  filled = Math.min(filled, width);
  const empty = width - filled;
  return fillChar.repeat(filled) + SQUARE_BLACK.repeat(empty);
}

/** Usage percentage at which the yellow band becomes active. Constant
 * across all bar widths. Cell 7 lights up at this threshold in a
 * 10-wide bar - in a 5-wide bar cell 4 lights up at the same point. */
export const CLAUDE_YELLOW_THRESHOLD = 70;
/** Usage percentage at which the red band becomes active. Constant
 * across all bar widths. Cell 9 lights up exactly at this threshold
 * in a 10-wide bar - in a 5-wide bar cell 4 is already lit from pct=70
 * and upgrades in place from yellow to red. Exported (with the yellow
 * gate) so the HTML tooltip color keys off the same moment. */
export const CLAUDE_RED_THRESHOLD = 85;

/** Build a Claude "rolling" heatmap progress bar with per-cell
 * coloring.
 *
 * Unlike the Codex heatmap which picks a single band color for the
 * whole filled portion, the Claude heatmap is position-aware: cells
 * past a configurable position are colored, cells below stay blue.
 * The active phase (blue / yellow / red) is driven by constant
 * percent thresholds (70 and 85) that don't depend on width, and the
 * "first colored cell" position is derived from the fill count at
 * those thresholds. This keeps the model aligned with the natural
 * cell crossovers of the default progress bar in both 10-wide and
 * 5-wide renderings without ever bumping the fill count.
 *
 * Rules (usedPct is the Claude utilization percentage, 0-100):
 *
 *   usedPct  <  70       blue phase   all filled cells blue
 *   70 <= usedPct <  85  yellow phase cells from firstYellowCell up
 *                                     to the current fill are yellow -
 *                                     cells below are blue
 *   85 <= usedPct <  100 red phase    cells from firstRedCell up to
 *                                     the current fill are red - cells
 *                                     below are blue (any previously
 *                                     yellow cell in that range
 *                                     "demotes" back to blue)
 *   usedPct  == 100      override     every cell is red
 *
 * In a 10-wide bar firstYellowCell=7 and firstRedCell=9, so the
 * yellow band is cells 7-8 and the red band is cells 9-10 with no
 * overlap. In a 5-wide bar firstYellowCell=4 and firstRedCell=4, so
 * cell 4 is yellow during 70-84 and upgrades in place to red at 85 -
 * the yellow and red bands share cell 4. That sharing is what lets
 * the compact bar avoid a dead zone after the 85% threshold without
 * needing any rounding hacks. */
function buildClaudeHeatmapBar(usedPct: number, width: number): string {
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

/** Build the Claude bar in remaining style - the fill is capacity
 * left, draining right to left. Claude's rolling per-cell rule
 * encodes used-position, which has no visual meaning on a draining
 * bar, so remaining style colors the whole fill by phase using the
 * SAME thresholds (yellow at 70% used, red at 85%). Edge handling
 * follows the remaining-bar grammar the Codex bar established: all
 * black when depleted, and a minimum of one red cell while red-phase
 * capacity remains so "almost gone" never reads as "no data". */
function buildClaudeRemainingHeatmapBar(usedPct: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, usedPct));
  const remainingPct = 100 - clamped;
  if (remainingPct <= 0) {
    return SQUARE_BLACK.repeat(width);
  }
  let fillChar = SQUARE_BLUE;
  if (clamped >= CLAUDE_RED_THRESHOLD) {
    fillChar = SQUARE_RED;
  } else if (clamped >= CLAUDE_YELLOW_THRESHOLD) {
    fillChar = SQUARE_YELLOW;
  }
  let filled = Math.round((remainingPct / 100) * width);
  if (clamped >= CLAUDE_RED_THRESHOLD && filled < 1) {
    filled = 1;
  }
  filled = Math.min(filled, width);
  return fillChar.repeat(filled) + SQUARE_BLACK.repeat(width - filled);
}

/** Build the Codex bar in used style - the fill is consumption,
 * growing left to right, using the same rolling per-cell model as
 * the Claude ascending bar so a warning reads as an accent, never a
 * wall (a whole-fill band here would paint 8 red cells the moment
 * 75% hits). The backfill stays green and only cells past the gate
 * positions color: with gates at 60/75 used (the native 40/25
 * remaining bands on the used scale), a 10-wide bar lights cell 6
 * yellow at 60, cells 6-7 through 74, then cell 8 red at 75 with
 * the yellow demoting back to green - and a 5-wide bar gates at
 * cells 3 and 4. Edge handling follows the used-bar grammar: every
 * cell red at 100% so maxed out is unmistakable, and a fresh window
 * is honestly near empty - no minimum-cell rule, because an empty
 * used bar means "barely used", not "no data". */
function buildCodexUsedHeatmapBar(usedPct: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, usedPct));
  if (clamped >= 100) {
    return SQUARE_RED.repeat(width);
  }
  const yellowThreshold = 100 - CODEX_YELLOW_REMAINING_THRESHOLD;
  const redThreshold = 100 - CODEX_RED_REMAINING_THRESHOLD;
  const filled = Math.round((clamped / 100) * width);
  const firstYellowCell = Math.round((yellowThreshold / 100) * width);
  const firstRedCell = Math.round((redThreshold / 100) * width);

  const cells: string[] = [];
  for (let i = 0; i < width; i++) {
    if (i >= filled) {
      cells.push(SQUARE_BLACK);
      continue;
    }
    const cellPos = i + 1; // 1-indexed to match firstYellowCell/firstRedCell
    if (clamped >= redThreshold && cellPos >= firstRedCell) {
      cells.push(SQUARE_RED);
    } else if (
      clamped >= yellowThreshold &&
      clamped < redThreshold &&
      cellPos >= firstYellowCell
    ) {
      cells.push(SQUARE_YELLOW);
    } else {
      cells.push(SQUARE_GREEN);
    }
  }
  return cells.join("");
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

