import {
  readAutoCompactOverride,
  writeAutoCompactOverride,
} from "../shared/claudeSettings";
import { ARMED_OVERRIDE_VALUE } from "./backups";
import { deleteSentinel, readSentinel } from "./sentinel";

/**
 * Recovery logic for the experimental Force Claude Auto-Compact.
 * Two-tier restore precedence, searched in order and poison-checked
 * at every tier ("1" is never a valid restore target):
 *
 *   1. `sentinel.originalOverride` if the sentinel exists and its
 *      recorded original is not the armed value
 *   2. `null` (key deletion) - restores Claude to its own built-in
 *      default formula, confirmed safe: when the key is absent
 *      Claude falls back to its internal threshold calculation
 *
 * Two entry points:
 *
 *   - `safeRestoreValue()` - in-memory disarm path with a sentinel
 *     object already in hand.
 *   - `healStuckOverride()` - inspects settings.json directly,
 *     called from `start()` and Reset WAT321. The only path that
 *     can recover a user whose sentinel is missing or corrupt. An
 *     unreadable settings file biases toward preserving the sentinel:
 *     on `io-error` we return without touching it, because the
 *     sentinel may be the only trustworthy record of the original
 *     value.
 */

export { ARMED_OVERRIDE_VALUE };

/** Never restore the override to the armed value. If the caller
 * passes "1" as the "original", treat the sentinel as corrupt and
 * restore to `null` (key deletion) so Claude falls back to its own
 * built-in default formula. `null` (key unset) is valid and
 * preserved as-is. */
export function safeRestoreValue(original: string | null): string | null {
  if (original === ARMED_OVERRIDE_VALUE) return null;
  return original;
}

export type HealResult =
  | "not-stuck"
  | "restored-from-sentinel"
  | "restored-to-default"
  | "no-settings"
  | "io-error";

/**
 * Inspect `~/.claude/settings.json` directly and, if the override is
 * stuck at `"1"`, restore via the two-tier precedence chain, then
 * clean up the sentinel.
 *
 * Safety invariant: an unreadable settings.json biases toward
 * preserve. On `io-error` we return without touching the sentinel,
 * because the sentinel may be the only trustworthy record of the
 * user's original value. Only a confirmed read of a non-`"1"` value
 * is allowed to delete an orphaned sentinel.
 */
export function healStuckOverride(): HealResult {
  const readResult = readAutoCompactOverride();
  if (readResult.kind === "missing") return "no-settings";
  if (readResult.kind === "io-error") return "io-error";

  if (readResult.value !== ARMED_OVERRIDE_VALUE) {
    deleteSentinel();
    return "not-stuck";
  }

  let target: string | null = null;
  let source: "sentinel" | "default" = "default";

  const sentinel = readSentinel();
  if (sentinel) {
    const candidate =
      sentinel.originalOverride === undefined ? null : sentinel.originalOverride;
    if (candidate !== ARMED_OVERRIDE_VALUE) {
      target = candidate;
      source = "sentinel";
    }
  }

  if (!writeAutoCompactOverride(target)) return "io-error";

  deleteSentinel();

  return source === "sentinel" ? "restored-from-sentinel" : "restored-to-default";
}
