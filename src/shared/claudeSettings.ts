import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read-only accessor for `~/.claude/settings.json` used by the Claude
 * session token widget to display the current auto-compact threshold.
 *
 * Invariant: never writes. All CLAUDE_* env keys are user-owned; WAT321
 * only reads them.
 *
 * Three env keys are relevant and tracked here:
 *   - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` - percentage (1-100). Most
 *     common user knob. Interpreted by Claude Code as "fire compaction
 *     when usage crosses this % of the effective context window".
 *   - `CLAUDE_CODE_AUTO_COMPACT_WINDOW` - absolute trigger token count.
 *     Rare, but if set it overrides the percentage path entirely.
 *   - `CLAUDE_CODE_MAX_CONTEXT_TOKENS` - declares the context window
 *     size. When Claude Code is on a 1M-variant model but this env
 *     key is unset, the percentage above gets applied to the wrong
 *     denominator (200k) and the widget overreports. We prefer this
 *     over the model-derived `contextWindowSize` when set.
 *
 * Effective-reserve caveat: empirically the percentage override in
 * recent Claude Code releases stacks with an internal reserve rather
 * than replacing it. Setting OVERRIDE=73 on a 1M window triggers
 * compaction around ~715k, not the nominal 730k. `OVERRIDE_EFFECTIVE_RESERVE`
 * captures that drift so the widget displays the real trigger point
 * instead of the nominal target. If future Claude Code releases change
 * this behavior, this is the one knob to update.
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
export function computeDefaultAutoCompactPct(contextWindowSize: number): number {
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
export function readAutoCompactOverrideRaw(): string | null {
  return readSettingsEnv("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE");
}

/** Raw `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` as an integer token count,
 * or null. When set this is an absolute trigger threshold and should
 * win over the percentage path. */
export function readAutoCompactWindow(): number | null {
  const raw = readSettingsEnv("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Raw `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` as an integer, or null.
 * Declares the context window size when Claude Code cannot infer it
 * from the model name. Preferred over the model-derived window when
 * set because the user may have 1M enabled without a `[1m]` tag. */
export function readMaxContextTokens(): number | null {
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
 * the empirical drift between the nominal override target and the
 * actual trigger. Priority: WINDOW env wins outright -> OVERRIDE env
 * percent minus OVERRIDE_EFFECTIVE_RESERVE -> default formula.
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
  if (absWindow !== null) return absWindow;

  const maxCtx = readMaxContextTokens();
  const effectiveWindow = maxCtx ?? contextWindowSize;

  const overrideRaw = readAutoCompactOverrideRaw();
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
