/**
 * Format a past timestamp as a compact relative-time string.
 * Returns forms like "just now", "12m ago", "3h ago", "2d ago".
 */
export function formatRelativeTime(pastMs: number): string {
  const deltaMs = Date.now() - pastMs;
  if (deltaMs < 60_000) return "just now";

  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
