/**
 * Constants for the experimental Force Claude Auto-Compact arm/disarm
 * cycle. The backup ring and install snapshot that used to live here
 * were removed once we confirmed that deleting
 * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` from `~/.claude/settings.json`
 * restores Claude to its own built-in default formula. That means the
 * sentinel is the only backup tier we need: it records the user's
 * original override (string for custom values, null for "key absent")
 * and the disarm/heal paths either restore that value or delete the
 * key. No hardcoded percentage is ever written.
 *
 * The armed override value is now calculated dynamically per arm
 * (currentPct - 5) so exactly one compact fires. `ARMED_OVERRIDE_VALUE`
 * below is retained for legacy heal detection: any override stuck at
 * "1" from a pre-v1.1.2 crash is still caught and restored on startup.
 */

/** Legacy armed value. Pre-v1.1.2 wrote this literal to settings.json.
 * Still used by the heal and preflight paths to detect stuck overrides
 * from older versions. The active arm path now calculates a dynamic
 * value instead - see `arm()` in `service.ts`. */
export const ARMED_OVERRIDE_VALUE = "1";
