import {
  SQUARE_BLACK,
  SQUARE_BLUE,
  SQUARE_RED,
  SQUARE_YELLOW,
} from "./heatmapPalette";

/**
 * Claude's heatmap bars. The used-direction bar colors per cell so a
 * warning reads as an accent, never a wall. The remaining-direction
 * bar colors its whole fill by phase, because a draining fill is only
 * a few cells by the time the gates hit. Both gate at the same
 * moments, 70 and 85 percent used, which align with natural cell
 * crossovers in 10-wide and 5-wide bars. `heatmap.ts` picks the bar
 * and applies the setting gate.
 */

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
 * Unlike the Codex band bar which picks a single color for the whole
 * filled portion, the Claude heatmap is position-aware: cells past a
 * configurable position are colored, cells below stay blue. The
 * active phase (blue / yellow / red) is driven by constant percent
 * thresholds (70 and 85) that don't depend on width, and the "first
 * colored cell" position is derived from the fill count at those
 * thresholds. This keeps the model aligned with the natural cell
 * crossovers of the default progress bar in both 10-wide and 5-wide
 * renderings without ever bumping the fill count.
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
export function buildClaudeHeatmapBar(usedPct: number, width: number): string {
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
export function buildClaudeRemainingHeatmapBar(usedPct: number, width: number): string {
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
