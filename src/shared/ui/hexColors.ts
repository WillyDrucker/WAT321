/**
 * Every hex color WAT321 paints onto status-bar text and tooltip bars.
 * Bar emoji cells carry their own intrinsic color and ignore
 * `item.color`, so these tint only codicons, numbers, and the HTML
 * bars inside tooltips. One home so a hue is retuned once.
 */

/** Idle or non-ok foreground for the usage widgets. Dim enough to read
 * as "paused, not live" on dark and light themes, still legible. */
export const IDLE_DIM_COLOR = "#404040";
/** Claude brand blue: the provider marker on the Claude usage widgets. */
export const CLAUDE_BRAND_BLUE = "#2977d6";
/** Codex brand green: the provider marker on the Codex usage widgets
 * and the healthy band of the Codex tooltip bar. */
export const CODEX_BRAND_GREEN = "#22c55e";
/** Healthy band of the Claude tooltip bar. */
export const CLAUDE_BAR_BLUE = "#3b82f6";
/** Caution band on both tooltip bars, and the compact-completion flash
 * text, so compact progress reads in the same amber as a warning. */
export const AMBER_WARNING = "#f59e0b";
/** Critical band on both tooltip bars. */
export const RED_CRITICAL = "#ef4444";
/** Session-token text at the yellow threshold while the heatmap is on. */
export const SESSION_TOKENS_YELLOW = "#eab308";
/** Session-token text at the white threshold. */
export const SESSION_TOKENS_WHITE = "#ffffff";
