/**
 * Timing and protocol constants shared by every usage polling service.
 * Kept in one place so tuning is centralized and two services cannot drift
 * out of sync on the hot path.
 */

/** Minimum interval between API polls per instance. */
export const POLL_INTERVAL_MS = 122_000;

/** Back off poll interval after we hit a 429 until we retry. Also the
 * hard ceiling for any server-supplied `Retry-After` value: a flailing
 * edge during an outage can return absurd Retry-After values (we have
 * seen 45 minutes), and honoring those literally leaves the widget
 * stuck long after the API recovers. We honor the spirit (back off,
 * don't hammer) by capping at our own conservative fallback. */
export const RATE_LIMIT_BACKOFF_MS = 901_000;

/** Minimum time the usage service must have been parked in
 * `rate-limited` before an activity-driven kickstart is allowed,
 * for a FRESH park (no prior failed kickstart rounds against the
 * current outage). Set to one full normal poll cycle plus one
 * second so the kickstart never fires inside the first natural
 * retry window. Subsequent failed rounds escalate through
 * `KICKSTART_ESCALATION_MS` below. */
export const KICKSTART_MIN_PARK_MS = POLL_INTERVAL_MS + 1_000;

/** Freshness window for the session-token activity signal that
 * gates kickstart. If the active transcript was last written more
 * recently than this, we treat the user as actively in a session
 * and consider any rate-limit park stale. */
export const KICKSTART_ACTIVITY_WINDOW_MS = 30_000;

/** Escalating minimum park times for the activity-driven kickstart
 * gate. Indexed by the `consecutiveFailedKickstarts` counter,
 * clamped to the final element. Element 0 is the responsive fresh
 * park; each subsequent element is a progressive friction step
 * applied after a kickstart round has failed (all post-wake strikes
 * exhausted without a successful fetch). The final element matches
 * `RATE_LIMIT_BACKOFF_MS` so once we reach it the kickstart is
 * effectively disabled for the remainder of the outage and the
 * natural park timer drives retries - no more wasted calls into a
 * server that is clearly still 429'ing us. The counter resets to
 * 0 on any successful fetch. */
export const KICKSTART_ESCALATION_MS: readonly number[] = [
  KICKSTART_MIN_PARK_MS, // 0 failures: responsive (~2 min)
  300_000,               // 1 failure:  5 min
  600_000,               // 2 failures: 10 min
  RATE_LIMIT_BACKOFF_MS, // 3+ failures: 15 min (kickstart off)
];

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
