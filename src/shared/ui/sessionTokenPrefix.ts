import { getDisplayMode } from "../../engine/displayMode";

/** Thought balloon glyph used as the session-token widget prefix in
 * compact and full display modes. U+1F4AD THOUGHT BALLOON. */
const THOUGHT = "\u{1F4AD}";
/** Heavy vertical separator used as the session-token widget prefix
 * in minimal mode so the widget stays tight on narrow status bars.
 * U+2503 BOX DRAWINGS HEAVY VERTICAL. */
const SEPARATOR = "\u{2503}";

/** Pick the prefix glyph for the current display mode. Minimal uses
 * the vertical separator to keep the widget tight; compact and full
 * use the thought balloon for visual identity across the richer
 * layouts. Shared by both the Claude and Codex session token widgets
 * so the two stay visually aligned with a single edit point. */
export function prefixForMode(): string {
  return getDisplayMode() === "minimal" ? SEPARATOR : THOUGHT;
}
