import { makeProgressBar } from "./progressBar";

/** Yellow square emoji for session token bars. */
const FILLED_YELLOW = "\uD83D\uDFE8";
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

/** Yellow/black block bar for session token context display */
export function makeTokenBar(pct: number, width: number = BAR_WIDTH): string {
  return makeProgressBar(pct, width, FILLED_YELLOW);
}
