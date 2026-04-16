import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Shared reader for `~/.claude/settings.json` `env` overrides.
 * The Claude session token widget reads the auto-compact override
 * to display the current threshold in the tooltip. All access is
 * read-only. One definition of the file path, one parser, one
 * default-value formula.
 */

export const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

/** System reserve cap and compact margin from Claude Code's internal
 * formula. When no `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is set, Claude
 * computes the threshold as:
 *   (fullWindow - min(systemReserve, SYSTEM_RESERVE_CAP)) - COMPACT_MARGIN
 * Confirmed via binary inspection and community reports (GitHub
 * anthropics/claude-code#31806). */
const SYSTEM_RESERVE_CAP = 20_000;
const COMPACT_MARGIN = 13_000;

/** Compute the default auto-compact percentage for a given context
 * window size using Claude's built-in formula. Returns the threshold
 * as a percentage of the full window (e.g. ~83 for 200k, ~97 for 1M).
 * Used only for display - the heal path restores to key deletion so
 * Claude always uses its own formula at runtime. */
export function computeDefaultAutoCompactPct(contextWindowSize: number): number {
  if (contextWindowSize <= 0) return 85;
  const threshold = contextWindowSize - SYSTEM_RESERVE_CAP - COMPACT_MARGIN;
  return Math.max(1, Math.min(100, Math.round((threshold / contextWindowSize) * 100)));
}

/**
 * Discriminated result for `readAutoCompactOverride`. Distinguishes
 * "file absent" and "file unreadable" from "file read OK but key
 * absent". The lossy `readAutoCompactOverrideRaw` wrapper below
 * collapses everything to `string | null` for the session token
 * widget, which only needs the display value.
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
 * display - falls back to the model-aware default. Do NOT
 * use from safety-critical paths - use `readAutoCompactOverride`
 * instead so you can distinguish IO error from "genuinely no
 * override set". */
export function readAutoCompactOverrideRaw(): string | null {
  const result = readAutoCompactOverride();
  if (result.kind !== "present") return null;
  return result.value;
}

/** Parse the override into a valid percentage (1-100), or compute
 * the model-aware default from Claude's built-in formula. The
 * context window size is needed for the default calculation so the
 * widget shows ~83% for 200k models and ~97% for 1M models instead
 * of a flat 85% for all models. */
export function readAutoCompactPct(contextWindowSize: number): number {
  const raw = readAutoCompactOverrideRaw();
  if (raw !== null) {
    const val = parseInt(raw, 10);
    if (val >= 1 && val <= 100) return val;
  }
  return computeDefaultAutoCompactPct(contextWindowSize);
}

