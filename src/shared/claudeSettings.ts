import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read-only accessor for `~/.claude/settings.json` used by the Claude
 * session token widget to display the current auto-compact threshold.
 *
 * Invariant: never writes. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is
 * user-owned; WAT321 only reads it.
 */

export const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

/**
 * Claude's built-in auto-compact formula (no override set):
 *   threshold = fullWindow - min(systemReserve, 20_000) - 13_000
 * Gives ~83% for 200k models, ~97% for 1M. Confirmed via binary
 * inspection and anthropics/claude-code#31806.
 */
const SYSTEM_RESERVE_CAP = 20_000;
const COMPACT_MARGIN = 13_000;

/** Default auto-compact percentage for a given context window size.
 * Display-only - Claude applies its own formula at runtime. */
export function computeDefaultAutoCompactPct(contextWindowSize: number): number {
  if (contextWindowSize <= 0) return 85;
  const threshold = contextWindowSize - SYSTEM_RESERVE_CAP - COMPACT_MARGIN;
  return Math.max(1, Math.min(100, Math.round((threshold / contextWindowSize) * 100)));
}

/** Raw `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` as a string, or null if
 * the file is absent, unreadable, or the key is not set. Lossy - any
 * read failure collapses to null. Safe for display paths. */
export function readAutoCompactOverrideRaw(): string | null {
  if (!existsSync(SETTINGS_PATH)) return null;
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
    const env = (settings.env as Record<string, unknown>) || {};
    const v = env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    if (v === null || v === undefined || v === "") return null;
    return typeof v === "string" ? v : String(v);
  } catch {
    return null;
  }
}

/** User override parsed as a valid percentage (1-100), or the
 * model-aware default. Context window size drives the default so
 * ~83% shows for 200k models and ~97% for 1M models. */
export function readAutoCompactPct(contextWindowSize: number): number {
  const raw = readAutoCompactOverrideRaw();
  if (raw !== null) {
    const val = parseInt(raw, 10);
    if (val >= 1 && val <= 100) return val;
  }
  return computeDefaultAutoCompactPct(contextWindowSize);
}
