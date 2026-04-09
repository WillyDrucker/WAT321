const FILLED = "\uD83D\uDFE6"; // Blue square
const EMPTY = "\u2B1B"; // Black square
const BAR_WIDTH = 10;

/** Format token count as compact string: 1234 -> "1k", 150000 -> "150k", 1000000 -> "1M" */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = Math.round(tokens / 1_000);
    return `${k}k`;
  }
  return `${tokens}`;
}

/** Format percentage, no decimals */
export function formatPct(pct: number): string {
  return `${Math.round(pct)}%`;
}

/** Blue/black block bar for token context display */
export function makeTokenBar(pct: number, width: number = BAR_WIDTH): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return FILLED.repeat(filled) + EMPTY.repeat(empty);
}
