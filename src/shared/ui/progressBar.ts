/** Black large square, shared empty cell for all progress bars. */
export const EMPTY_SQUARE = "\u2B1B";

/** Build an emoji progress bar of `width` cells, filled proportional
 * to `pct`. The caller supplies the fill character (blue for Claude,
 * green for Codex, yellow for session tokens). */
export function makeProgressBar(
  pct: number,
  width: number,
  filledChar: string
): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return filledChar.repeat(filled) + EMPTY_SQUARE.repeat(empty);
}
