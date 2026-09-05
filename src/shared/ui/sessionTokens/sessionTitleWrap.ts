/**
 * Soft-wrap for session titles in tooltips. VS Code's MarkdownString
 * wraps at the rendered line, but a per-line cap keeps a very long
 * title from producing an unreadably wide tooltip. Up to two visual
 * lines, then an ellipsis.
 */

const MAX_TITLE_LINE_LEN = 38;

/** Wrap a long session title across up to two lines, breaking on a
 * word boundary inside the first line's character budget. Titles
 * that fit on one line are returned unchanged - titles that exceed
 * two lines are ellipsis-truncated. The Claude, Codex, and OpenCode
 * Routes widgets all wrap through here. */
export function wrapAndTruncateTitle(sessionTitle: string | undefined): string {
  if (!sessionTitle) return "";
  if (sessionTitle.length <= MAX_TITLE_LINE_LEN) return sessionTitle;
  // Find the last space at or before MAX_TITLE_LINE_LEN so the wrap
  // happens between words. Falls back to a hard break if no space is
  // present in that window (e.g. a single very long token).
  const lastSpace = sessionTitle.lastIndexOf(" ", MAX_TITLE_LINE_LEN);
  const breakAt = lastSpace > 0 ? lastSpace : MAX_TITLE_LINE_LEN;
  const firstLine = sessionTitle.slice(0, breakAt).trimEnd();
  const remainder = sessionTitle.slice(breakAt).trimStart();
  if (remainder.length <= MAX_TITLE_LINE_LEN) {
    return `${firstLine}\n${remainder}`;
  }
  return `${firstLine}\n${remainder.slice(0, MAX_TITLE_LINE_LEN - 3)}...`;
}
