import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read-only accessor for `~/.claude/settings.json` used by the Claude
 * session token widget to display the current auto-compact threshold.
 * Never writes. All CLAUDE_* env keys are user-owned, this module only
 * reads them.
 *
 * Three env keys participate in the threshold computation:
 *   - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` - percentage 1-100, only
 *     effective when paired with WINDOW below.
 *   - `CLAUDE_CODE_AUTO_COMPACT_WINDOW` - the denominator the
 *     percentage applies to. Effective trigger lands around
 *     `(pct / 100) * window` minus `OVERRIDE_EFFECTIVE_RESERVE`.
 *   - `CLAUDE_CODE_MAX_CONTEXT_TOKENS` - context window override,
 *     preferred over the model-derived window for 1M sessions where
 *     the model tag may be absent.
 *
 * `OVERRIDE_EFFECTIVE_RESERVE` documents the empirical drift between
 * the nominal override target and Claude Code's actual compaction
 * trigger. Update that constant if Claude Code's behavior shifts.
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

/**
 * Empirical delta between the percentage override's nominal target
 * and the actual compaction trigger in recent Claude Code releases.
 * Observed on 1M sessions: OVERRIDE=73 -> fires ~715k (nominal 730k,
 * ~15k short). Applied as an absolute token subtraction when computing
 * the displayed threshold from a user-supplied override. Not applied
 * to the default (no-override) formula - the SYSTEM_RESERVE_CAP +
 * COMPACT_MARGIN path already models the no-override reserve.
 *
 * See anthropics/claude-code#31806, #43989, #50204 for drift context.
 */
const OVERRIDE_EFFECTIVE_RESERVE = 15_000;

/** Default auto-compact percentage for a given context window size.
 * Display-only - Claude applies its own formula at runtime. */
function computeDefaultAutoCompactPct(contextWindowSize: number): number {
  if (contextWindowSize <= 0) return 85;
  const threshold = contextWindowSize - SYSTEM_RESERVE_CAP - COMPACT_MARGIN;
  return Math.max(1, Math.min(100, Math.round((threshold / contextWindowSize) * 100)));
}

/** Read an env value from `~/.claude/settings.json` `env` block. Lossy -
 * any read/parse failure collapses to null. */
function readSettingsEnv(key: string): string | null {
  if (!existsSync(SETTINGS_PATH)) return null;
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
    const env = (settings.env as Record<string, unknown>) || {};
    const v = env[key];
    if (v === null || v === undefined || v === "") return null;
    return typeof v === "string" ? v : String(v);
  } catch {
    return null;
  }
}

/** Raw `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` as a string, or null if
 * the file is absent, unreadable, or the key is not set. Lossy - any
 * read failure collapses to null. Safe for display paths. */
function readAutoCompactOverrideRaw(): string | null {
  return readSettingsEnv("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE");
}

/** Raw `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` as an integer token count,
 * or null. When paired with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` this
 * declares the denominator the percentage applies to (the pair
 * branch wins in `readAutoCompactEffectiveTriggerTokens`). Without
 * the percentage pair, older Claude Code releases treated this as
 * an absolute trigger threshold. Current releases may ignore it
 * alone. The reader stays a thin env accessor either way. */
function readAutoCompactWindow(): number | null {
  const raw = readSettingsEnv("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Raw `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` as an integer, or null.
 * Declares the context window size when Claude Code cannot infer it
 * from the model name. Preferred over the model-derived window when
 * set because the user may have 1M enabled without a `[1m]` tag. */
function readMaxContextTokens(): number | null {
  const raw = readSettingsEnv("CLAUDE_CODE_MAX_CONTEXT_TOKENS");
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
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

/** Real auto-compact fire point in absolute tokens, accounting for
 * the empirical drift between the nominal target and the actual
 * trigger. Resolution order:
 *   1. WINDOW + PCT pair (current Claude Code behavior). WINDOW
 *      declares the denominator, PCT is the percentage applied to
 *      it. Effective trigger = `(pct / 100) * window` minus the
 *      empirical drift reserve.
 *   2. WINDOW alone (legacy interpretation). Older Claude Code
 *      releases treated this as an absolute trigger. Current releases
 *      appear to ignore PCT without WINDOW and may also ignore WINDOW
 *      alone. Kept here so users on older Claude Code that still
 *      honor it see the right number.
 *   3. PCT alone applied to MAX_CONTEXT (legacy interpretation).
 *      Currently defunct in recent Claude Code releases, but kept for
 *      backward compatibility with older releases where it still
 *      worked.
 *   4. Built-in default formula on the effective context window.
 *
 * Widget consumers use this as the unified denominator for bars, the
 * displayed percentage, the "N/M" numerator's right-hand side, and
 * the "Auto-Compact at ~X" tooltip line. The nominal ceiling
 * (`autoCompactPct * contextWindow`) is no longer surfaced anywhere -
 * showing 73% / 730k while compaction actually fires at 715k confused
 * the percentage / fire-point relationship. The widget now reports the
 * actual hit point everywhere it shows a target. */
export function readAutoCompactEffectiveTriggerTokens(
  contextWindowSize: number
): number {
  const absWindow = readAutoCompactWindow();
  const overrideRaw = readAutoCompactOverrideRaw();

  if (absWindow !== null && overrideRaw !== null) {
    const pct = parseInt(overrideRaw, 10);
    if (pct >= 1 && pct <= 100) {
      const nominal = Math.round((pct / 100) * absWindow);
      return Math.max(1, nominal - OVERRIDE_EFFECTIVE_RESERVE);
    }
  }

  if (absWindow !== null) return absWindow;

  const maxCtx = readMaxContextTokens();
  const effectiveWindow = maxCtx ?? contextWindowSize;

  if (overrideRaw !== null) {
    const pct = parseInt(overrideRaw, 10);
    if (pct >= 1 && pct <= 100) {
      const nominal = Math.round((pct / 100) * effectiveWindow);
      return Math.max(1, nominal - OVERRIDE_EFFECTIVE_RESERVE);
    }
  }

  // Default path already subtracts the documented reserve, so the
  // effective trigger and nominal ceiling coincide when no override
  // is set. Return the same number both consumers would compute.
  const defaultPct = computeDefaultAutoCompactPct(effectiveWindow);
  return Math.round((defaultPct / 100) * effectiveWindow);
}
