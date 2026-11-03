import type { DisplayMode } from "../../engine/displayMode";
import { isProviderActive } from "../../engine/displayMode";
import { getRemainingPct } from "../codexUsage/codexUsageFormatters";
import { bandFromRemaining } from "./codexHeatmapBar";
import { isHeatmapEnabled } from "./heatmap";
import {
  CLAUDE_BRAND_BLUE,
  CODEX_BRAND_GREEN,
  SESSION_TOKENS_WHITE,
  SESSION_TOKENS_YELLOW,
} from "./hexColors";

/**
 * Text color resolvers for WAT321 widgets. Kept apart from
 * `heatmap.ts` so widgets that only need text colors do not import
 * bar rendering. Each resolver returns a hex color or `undefined`
 * (fall back to the theme's default status bar foreground).
 */

/** Resolve the text color for a session token widget at the given
 * percent of the auto-compact ceiling. Each widget passes its own warn
 * thresholds, because a Claude ceiling is the literal compact trigger
 * while a Codex ceiling is the effective context window. White from the
 * white threshold, and yellow from the yellow one while the heatmap is on. */
export function getSessionTokenColor(
  pctOfCeiling: number,
  whitePct: number,
  yellowPct: number
): string | undefined {
  if (isHeatmapEnabled() && pctOfCeiling >= yellowPct) return SESSION_TOKENS_YELLOW;
  if (pctOfCeiling >= whitePct) return SESSION_TOKENS_WHITE;
  return undefined;
}

/** Resolve the text color for a Claude usage widget.
 *
 * Brand blue is applied ONLY when heatmap is on, mode is minimal,
 * AND Codex is also active. The blue functions as a "this is
 * Claude" provider marker that only has meaning when there is
 * another provider to distinguish from. */
export function getClaudeTextColor(
  mode: DisplayMode
): string | undefined {
  if (!isHeatmapEnabled()) return undefined;
  if (!isProviderActive("codex")) return undefined;
  if (mode === "minimal") return CLAUDE_BRAND_BLUE;
  return undefined;
}

/** Resolve the text color for a Codex usage widget.
 *
 * Brand green is applied ONLY when heatmap is on AND Claude is
 * also active AND either the widget is in minimal view OR the
 * current band is non-green (a severity signal in compact/full). */
export function getCodexTextColor(
  mode: DisplayMode,
  usedPct: number
): string | undefined {
  if (!isHeatmapEnabled()) return undefined;
  if (!isProviderActive("claude")) return undefined;
  if (mode === "minimal") return CODEX_BRAND_GREEN;
  const remainingPct = getRemainingPct(usedPct);
  if (bandFromRemaining(remainingPct) !== "green") return CODEX_BRAND_GREEN;
  return undefined;
}
