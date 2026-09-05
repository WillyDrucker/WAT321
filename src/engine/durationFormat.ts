/**
 * Human-readable time spans for status bars, tooltips, and the health
 * panel. `formatRelativeTime` answers "how long ago" for a past
 * timestamp, `formatDuration` answers "how long" for an elapsed span.
 * One home so every surface reads the same way.
 */

/** "just now", "12m ago", "3h ago", "2d ago". */
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

/** "350ms", "45s", "3m 12s", "1h 22m". Sub-minute spans keep a
 * single unit, longer spans two, and a zero remainder is dropped. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}
