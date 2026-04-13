import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Shared reader/writer for `~/.claude/settings.json` `env` overrides.
 * Two WAT321 features touch this file:
 *   - Claude session token widget (read-only, displays the override)
 *   - Claude Force Auto-Compact (read + atomic write, arm/restore cycle)
 * Both now route through this module to keep exactly one definition of
 * the file path, one parser, one atomic writer, and one default value.
 */

export const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

/**
 * Claude's auto-compact default threshold, as a percentage. Used when
 * the user has no `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` set, AND as the
 * failsafe target when Force Auto-Compact heals a stuck override with
 * no trustworthy sentinel to restore from.
 *
 * Claude's real default is approximately
 *   fullWindow - min(systemReserve, 20000) - 13000 tokens
 * which works out to ~83-86% for 200k models and ~96.7% for 1M models.
 * 85 is a single fallback that is approximately correct for 200k
 * models. A model-aware fallback is tracked in issue #38.
 */
export const DEFAULT_CLAUDE_AUTOCOMPACT_PCT = 85;

/** String form, used when writing to settings.json. */
export const DEFAULT_CLAUDE_AUTOCOMPACT_PCT_STR = "85";

/**
 * Discriminated result for `readAutoCompactOverride`. Distinguishes
 * "file absent" and "file unreadable" from "file read OK but key
 * absent" so safety-critical callers (Force Auto-Compact heal, arm)
 * can refuse to make assumptions on an IO error. The lossy
 * `readAutoCompactOverrideRaw` wrapper below collapses everything to
 * `string | null` for the session token widget, which only needs the
 * display value.
 */
export type OverrideReadResult =
  | { kind: "missing" }
  | { kind: "present"; value: string | null }
  | { kind: "io-error" };

/** Read `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` with distinct outcomes
 * for missing file / read OK / IO error. The empty string is treated
 * as "key absent" (`value: null`) on the happy path. */
export function readAutoCompactOverride(): OverrideReadResult {
  if (!existsSync(SETTINGS_PATH)) return { kind: "missing" };
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const env = (settings.env as Record<string, unknown>) || {};
    const v = env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    if (v === null || v === undefined || v === "") {
      return { kind: "present", value: null };
    }
    return {
      kind: "present",
      value: typeof v === "string" ? v : String(v),
    };
  } catch {
    return { kind: "io-error" };
  }
}

/** Lossy wrapper for display-only callers. Returns `null` for ANY
 * reason the override cannot be read as a string (absent file, IO
 * error, key missing). Used by the Claude session token widget for
 * display - falls back to `DEFAULT_CLAUDE_AUTOCOMPACT_PCT`. Do NOT
 * use from safety-critical paths - use `readAutoCompactOverride`
 * instead so you can distinguish IO error from "genuinely no
 * override set". */
export function readAutoCompactOverrideRaw(): string | null {
  const result = readAutoCompactOverride();
  if (result.kind !== "present") return null;
  return result.value;
}

/** Parse the override into a valid percentage (1-100), or fall back
 * to `DEFAULT_CLAUDE_AUTOCOMPACT_PCT`. This is what the session token
 * widget uses for display. */
export function readAutoCompactPct(): number {
  const raw = readAutoCompactOverrideRaw();
  if (raw !== null) {
    const val = parseInt(raw, 10);
    if (val >= 1 && val <= 100) return val;
  }
  return DEFAULT_CLAUDE_AUTOCOMPACT_PCT;
}

/**
 * Atomic `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` writer. `target === null`
 * deletes the key entirely (user had no override originally).
 * tmp+rename so a crash mid-write cannot truncate the file.
 *
 * Returns `true` on success, `false` on any IO error. This is the
 * only writer WAT321 ever uses against `~/.claude/settings.json`.
 */
export function writeAutoCompactOverride(target: string | null): boolean {
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const env = (settings.env as Record<string, unknown>) || {};
    if (target === null) {
      delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    } else {
      env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = target;
    }
    settings.env = env;
    const tmp = `${SETTINGS_PATH}.wat321.tmp`;
    writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
    renameSync(tmp, SETTINGS_PATH);
    return true;
  } catch {
    return false;
  }
}
