import type { DisplayMode } from "../../engine/displayMode";
import { isProviderActive } from "../../engine/displayMode";
import { getRemainingPct } from "../codex-usage/formatters";
import { bandFromRemaining, isHeatmapEnabled } from "./heatmap";

/**
 * Text color resolvers for WAT321 widgets. Separated from heatmap.ts
 * so widgets that only need text colors don't import bar-rendering
 * logic. Each resolver returns a hex color string or `undefined`
 * (fall back to the theme's default status bar foreground).
 */

/** Resolve the text color for a session token widget at the given
 * percent of the auto-compact ceiling. Thresholds are parameterized
 * because Claude and Codex have different ceiling semantics:
 *
 *   - **Claude** ceiling is the literal compact trigger. Warn levels
 *     default to 90 / 95 - one or two turns of runway before the cap.
 *
 *   - **Codex** ceiling is the effective context window with a
 *     baseline-normalized display. Warn levels are shifted to 85 / 90
 *     so yellow lands ~11k tokens before compact.
 *
 * Heatmap off -> white at the white threshold only.
 * Heatmap on -> yellow-500 at the yellow threshold (plus white
 * between white and yellow).
 */
export function getSessionTokenColor(
  pctOfCeiling: number,
  whitePct: number = 90,
  yellowPct: number = 95
): string | undefined {
  if (isHeatmapEnabled() && pctOfCeiling >= yellowPct) return "#eab308";
  if (pctOfCeiling >= whitePct) return "#ffffff";
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
  if (mode === "minimal") return "#2977d6";
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
  if (mode === "minimal") return "#22c55e";
  const remainingPct = getRemainingPct(usedPct);
  if (bandFromRemaining(remainingPct) !== "green") return "#22c55e";
  return undefined;
}
