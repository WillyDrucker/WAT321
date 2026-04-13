/**
 * Timing and protocol constants shared by every usage polling service.
 * Kept in one place so tuning is centralized and two services cannot drift
 * out of sync on the hot path.
 */

/** Minimum interval between API polls per instance. */
export const POLL_INTERVAL_MS = 122_000;

/** Back off poll interval after we hit a 429 until we retry. Used
 * as a fallback when the server response has no `Retry-After`
 * header. When `Retry-After` is present, it takes precedence. */
export const RATE_LIMIT_BACKOFF_MS = 901_000;

/** Minimum time between fetches before another instance can take the claim. */
export const FETCH_COOLDOWN_MS = 61_000;

/** Shared cache freshness window for OK and rate-limited states. */
export const CACHE_FRESHNESS_OK_MS = 115_000;

/**
 * Shared cache freshness window for auth and error states. Shorter than
 * the OK window so another window can recheck quickly once the user fixes
 * credentials or the transient failure clears.
 */
export const CACHE_FRESHNESS_ERROR_MS = 30_000;

/** How long a stale claim file is tolerated before another instance reclaims. */
export const CLAIM_TTL_MS = 30_000;

/** HTTPS request timeout for usage API calls. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Status codes treated as auth failures. */
export const AUTH_ERROR_CODES: ReadonlySet<number> = new Set([401, 403]);

/** Startup jitter to stagger simultaneous instance starts. */
export const STARTUP_JITTER_MS = 5_000;

/** How many consecutive failures before surfacing an error to the user. */
export const ERROR_ABSORPTION_THRESHOLD = 3;

/**
 * Exponential discovery backoff for detecting when a provider CLI becomes
 * installed after the extension is already running. Fast early to catch
 * quick installs, slower later to stop hammering the filesystem for users
 * who will never install.
 */
export interface DiscoveryBackoffStep {
  readonly untilMs: number;
  readonly intervalMs: number;
}

export const DISCOVERY_BACKOFF: readonly DiscoveryBackoffStep[] = [
  { untilMs: 5 * 60_000, intervalMs: 60_000 },      // 0-5 min: every 60s
  { untilMs: 30 * 60_000, intervalMs: 5 * 60_000 }, // 5-30 min: every 5 min
  { untilMs: Infinity, intervalMs: 15 * 60_000 },   // 30+ min: every 15 min
];
