/** Blue square emoji, the default fill character for Claude progress
 * bars. U+1F7E6 LARGE BLUE SQUARE. */
const FILLED_BLUE = "\uD83D\uDFE6";
const EMPTY = "\u2B1B";

/** Build an emoji progress bar of `width` cells, filled proportional
 * to `pct`. Defaults to blue squares. Callers can override the fill
 * character (for example with a heatmap band color from
 * `src/shared/ui/heatmap.ts`) without needing a separate formatter. */
export function makeBar(
  pct: number,
  width: number = 10,
  filledChar: string = FILLED_BLUE
): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return filledChar.repeat(filled) + EMPTY.repeat(empty);
}

export function getMaxLabel(
  extraUsage: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
  } | null
): string {
  if (!extraUsage?.is_enabled) return "";
  const limit = extraUsage.monthly_limit;
  if (limit === 5000) return "Max (5x)";
  if (limit === 10000) return "Max (10x)";
  if (limit === 20000) return "Max (20x)";
  return `Max ($${limit / 100})`;
}
