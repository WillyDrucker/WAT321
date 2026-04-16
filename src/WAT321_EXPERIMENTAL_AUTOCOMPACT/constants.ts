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
 */

/** The override value WAT321 writes while armed. */
export const ARMED_OVERRIDE_VALUE = "1";
