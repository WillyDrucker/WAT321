/**
 * The emoji cells every WAT321 progress bar is built from. Blue is
 * Claude's base, green is Codex's, yellow and red are the heatmap
 * bands, black is empty. Orange belongs to the Claude compact-progress
 * bar alone: compact is a distinct widget state, not a usage severity,
 * so it is never a heatmap band.
 */

/** U+1F7E6 LARGE BLUE SQUARE. */
export const SQUARE_BLUE = "🟦";
/** U+1F7E9 LARGE GREEN SQUARE. */
export const SQUARE_GREEN = "🟩";
/** U+1F7E8 LARGE YELLOW SQUARE. */
export const SQUARE_YELLOW = "🟨";
/** U+1F7E7 LARGE ORANGE SQUARE, the Claude compact-progress fill. */
export const SQUARE_ORANGE_COMPACT = "🟧";
/** U+1F7E5 LARGE RED SQUARE. */
export const SQUARE_RED = "🟥";
/** U+2B1B BLACK LARGE SQUARE, the empty cell. */
export const SQUARE_BLACK = "⬛";

export type HeatmapBand = "green" | "yellow" | "red";
