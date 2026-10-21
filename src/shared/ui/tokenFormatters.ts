import * as vscode from "vscode";
import { SETTING } from "../../engine/settingsKeys";
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

/** Inline tokens-per-second suffix for widget text. Three digits at
 * most (services cap at 999), one decimal below 10 so a slow local
 * LLM at 3.4 tps does not round to 3. Empty in minimal mode, while
 * `wat321.enableTokensPerSecondCounters` is off (the default, so the
 * widget reads as plain count + percentage), and before the first
 * reading so a fresh session never shows "0tps". */
export function tpsSuffix(
  tps: number | null | undefined,
  mode: "full" | "compact" | "minimal"
): string {
  if (mode === "minimal") return "";
  if (
    !vscode.workspace
      .getConfiguration("wat321")
      .get<boolean>(SETTING.enableTokensPerSecondCounters, false)
  ) {
    return "";
  }
  if (typeof tps !== "number" || tps <= 0) return "";
  const formatted = tps >= 10 ? `${Math.round(tps)}` : tps.toFixed(1);
  return ` ${formatted}tps`;
}
