import { existsSync, readFileSync } from "fs";
import type { ClaudeForceAutoCompactSentinel } from "./types";
import {
  DEFAULT_CLAUDE_AUTOCOMPACT_PCT_STR,
  readAutoCompactOverride,
  writeAutoCompactOverride,
} from "../shared/claudeSettings";
import { deleteSentinel, SENTINEL_PATH } from "./sentinel";

/**
 * Recovery logic for Claude Force Auto-Compact. The service never
 * trusts "1" (the WAT321 armed value) as a restore target: if the
 * sentinel is missing or its `originalOverride` is itself "1", we
 * fall back to the Claude default. Two entry points:
 *
 *   - `safeRestoreValue()` - coerces the WAT321 armed value to the
 *     Claude default; used inside the normal disarm path.
 *   - `healStuckOverride()` - inspects settings.json directly, used
 *     as the startup failsafe and by Reset WAT321. This is the ONLY
 *     path that can recover a user whose sentinel is missing,
 *     corrupt, or self-referential.
 */

/** The override value we write while armed. Treated as "never trust
 * this as an original" throughout the restore logic. */
export const ARMED_OVERRIDE_VALUE = "1";

/** Never restore the override to the WAT321-armed value. If the caller
 * passes "1" as the "original", treat the sentinel as corrupt and
 * substitute the Claude default. `null` (key unset) is valid and is
 * preserved as-is. */
export function safeRestoreValue(original: string | null): string | null {
  if (original === ARMED_OVERRIDE_VALUE) return DEFAULT_CLAUDE_AUTOCOMPACT_PCT_STR;
  return original;
}

export type HealResult =
  | "not-stuck"
  | "restored-from-sentinel"
  | "restored-to-default"
  | "no-settings"
  | "io-error";

/**
 * Inspect `~/.claude/settings.json` directly and, if
 * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is stuck at the WAT321 armed value
 * `"1"`, restore it to a safe value and clean up the sentinel.
 *
 * Restore target precedence:
 *   1. `sentinel.originalOverride` if the sentinel exists and its
 *      original is NOT `"1"` (string, or `null` for "no override")
 *   2. `"85"` (Claude's default auto-compact threshold) otherwise
 *
 * **Safety: unreadable settings.json biases toward preserve.** The
 * reader distinguishes "missing file" / "present" / "io-error".
 * On `io-error` we return `"io-error"` WITHOUT touching the sentinel.
 * The sentinel may be the only trustworthy record of the original
 * override, so a corrupt settings file must never let us delete it.
 * Only a confirmed read of a non-`"1"` value ("present" with value
 * not equal to the armed value) is allowed to clean up an orphaned
 * sentinel.
 *
 * This is called from `start()` (no-sentinel / stale paths),
 * `retryStaleRestore` (widget click retry), and `clearSettings`
 * (Reset WAT321). Running any of those MUST unstick the user, even
 * if the sentinel is missing, corrupt, or self-referential - but
 * must also NOT make things worse if the settings file itself is
 * the broken piece.
 */
export function healStuckOverride(): HealResult {
  const readResult = readAutoCompactOverride();
  if (readResult.kind === "missing") return "no-settings";
  if (readResult.kind === "io-error") return "io-error";

  if (readResult.value !== ARMED_OVERRIDE_VALUE) {
    // Confirmed not stuck (file read OK, value is not the armed
    // value). Safe to best-effort clean up any orphaned sentinel
    // so a stale copy can't confuse a later start() or arm() check.
    deleteSentinel();
    return "not-stuck";
  }

  // Stuck. Try to use the sentinel's original value, but never trust
  // "1" (that would just re-stick us). Fall back to the Claude default.
  let target: string | null = DEFAULT_CLAUDE_AUTOCOMPACT_PCT_STR;
  let usedSentinel = false;
  try {
    if (existsSync(SENTINEL_PATH)) {
      const raw = readFileSync(SENTINEL_PATH, "utf8");
      const sentinel = JSON.parse(raw) as Partial<ClaudeForceAutoCompactSentinel>;
      if (sentinel && "originalOverride" in sentinel) {
        const candidate =
          sentinel.originalOverride === undefined ? null : sentinel.originalOverride;
        if (candidate !== ARMED_OVERRIDE_VALUE) {
          target = candidate;
          usedSentinel = true;
        }
      }
    }
  } catch {
    // Sentinel unreadable - stick with the default fallback.
  }

  if (!writeAutoCompactOverride(target)) return "io-error";

  // Settings healed - the sentinel is now stale garbage regardless
  // of which branch we took.
  deleteSentinel();
  return usedSentinel ? "restored-from-sentinel" : "restored-to-default";
}
