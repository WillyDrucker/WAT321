import {
  SQUARE_BLACK,
  SQUARE_GREEN,
  SQUARE_RED,
  SQUARE_YELLOW,
  type HeatmapBand,
} from "./heatmapPalette";

/**
 * Codex's heatmap bars. The remaining-direction bar (Codex's native
 * count-down) colors its whole fill by band, since a draining fill is
 * only a few cells by the time the gates hit. The used-direction bar
 * colors per cell like Claude's so a warning reads as an accent. Both
 * derive from the same 40/25 remaining thresholds the ChatGPT usage
 * dashboard draws (Tailwind green-500 / red-400), so both directions
 * agree on the moment severity starts. `heatmap.ts` picks the bar and
 * applies the setting gate.
 */

/** Codex heatmap thresholds, defined on remaining capacity. The
 * used-direction rolling bar derives its cell gates from these same
 * values expressed on the used scale (yellow at 60% used, red at 75%). */
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
export function buildCodexHeatmapBar(usedPct: number, width: number): string {
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
export function buildCodexUsedHeatmapBar(usedPct: number, width: number): string {
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
