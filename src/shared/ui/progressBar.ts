import { SQUARE_BLACK } from "./heatmapPalette";

/** Build an emoji progress bar of `width` cells, filled proportional to
 * `pct`. The caller supplies the fill cell from the palette, and the
 * empty cells are the palette's black square. */
export function makeProgressBar(
  pct: number,
  width: number,
  filledChar: string
): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return filledChar.repeat(filled) + SQUARE_BLACK.repeat(empty);
}
