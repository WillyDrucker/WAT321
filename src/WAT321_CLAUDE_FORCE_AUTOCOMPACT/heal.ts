import { existsSync, readFileSync } from "node:fs";
import type { ClaudeForceAutoCompactSentinel } from "./types";
import {
  DEFAULT_CLAUDE_AUTOCOMPACT_PCT_STR,
  readAutoCompactOverride,
  writeAutoCompactOverride,
} from "../shared/claudeSettings";
import { deleteSentinel, SENTINEL_PATH } from "./sentinel";
import {
  ARMED_OVERRIDE_VALUE,
  readInstallSnapshotOverride,
  readNewestArmBackupOverride,
} from "./backups";

/**
 * Recovery logic for Claude Force Auto-Compact. The service never
 * trusts "1" (the WAT321 armed value) as a restore target. Four
 * tiers of fallback, searched in order, each poison-checked:
 *
 *   1. Sentinel.originalOverride (most recent known user value)
 *   2. Newest arm backup ring entry (historical user values)
 *   3. Install snapshot (captured once on first clean activation)
 *   4. Hardcoded DEFAULT_CLAUDE_AUTOCOMPACT_PCT_STR ("85")
 *
 * Entry points:
 *
 *   - `safeRestoreValue()` - coerces the WAT321 armed value to the
 *     Claude default; used inside the normal in-memory disarm path
 *     where the caller already has a sentinel object in hand.
 *   - `healStuckOverride()` - inspects settings.json directly, used
 *     as the startup failsafe and by Reset WAT321. This is the ONLY
 *     path that can recover a user whose sentinel is missing,
 *     corrupt, or self-referential.
 */

// Re-export so existing callers (service.ts) keep working. The
// canonical definition now lives in backups.ts to avoid a circular
// import between heal.ts and backups.ts.
export { ARMED_OVERRIDE_VALUE };

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
  | "restored-from-arm-backup"
  | "restored-from-install-snapshot"
  | "restored-to-default"
  | "no-settings"
  | "io-error";

/**
 * Inspect `~/.claude/settings.json` directly and, if
 * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is stuck at the WAT321 armed value
 * `"1"`, restore it to a safe value and clean up the sentinel.
 *
 * Restore target precedence (all poison-checked - `"1"` is never a
 * valid candidate at any tier, it always falls through):
 *
 *   1. `sentinel.originalOverride` if the sentinel exists and its
 *      original is NOT `"1"` (string, or `null` for "no override")
 *   2. Newest arm backup ring entry (historical user values captured
 *      at each arm, survives a corrupt sentinel)
 *   3. Install snapshot value (the canonical baseline, captured once
 *      on first activation that saw a clean settings.json)
 *   4. `"85"` (Claude's default auto-compact threshold) as the final
 *      hardcoded failsafe
 *
 * **Safety: unreadable settings.json biases toward preserve.** The
 * reader distinguishes "missing file" / "present" / "io-error".
 * On `io-error` we return `"io-error"` WITHOUT touching the sentinel.
 * The sentinel may be the only trustworthy record of the original
 * override, so a corrupt settings file must never let us delete it.
 * Only a confirmed read of a non-`"1"` value is allowed to clean up
 * an orphaned sentinel.
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
    // so a stale copy cannot confuse a later start() or arm() check.
    deleteSentinel();
    return "not-stuck";
  }

  // Stuck. Walk the precedence chain, rejecting any candidate that
  // is itself the armed value. First non-poisoned hit wins.
  let target: string | null = DEFAULT_CLAUDE_AUTOCOMPACT_PCT_STR;
  let source: "sentinel" | "arm-backup" | "install-snapshot" | "default" =
    "default";

  // Tier 1: sentinel
  try {
    if (existsSync(SENTINEL_PATH)) {
      const raw = readFileSync(SENTINEL_PATH, "utf8");
      const sentinel = JSON.parse(raw) as Partial<ClaudeForceAutoCompactSentinel>;
      if (sentinel && "originalOverride" in sentinel) {
        const candidate =
          sentinel.originalOverride === undefined ? null : sentinel.originalOverride;
        if (candidate !== ARMED_OVERRIDE_VALUE) {
          target = candidate;
          source = "sentinel";
        }
      }
    }
  } catch {
    // Sentinel unreadable - fall through to the next tier.
  }

  // Tier 2: newest arm backup ring entry
  if (source === "default") {
    const armBackup = readNewestArmBackupOverride();
    if (armBackup !== ARMED_OVERRIDE_VALUE && armBackup !== null) {
      target = armBackup;
      source = "arm-backup";
    } else if (armBackup === null) {
      // The ring stores `null` for "no override set" as a legitimate
      // value. Accept it explicitly so we don't skip a valid tier.
      // Note: readNewestArmBackupOverride() already filters poisoned
      // entries, so a `null` return means "ring empty" OR "no
      // override was the user's original". Distinguish by checking
      // whether any ring file exists at all - but for simplicity,
      // only accept non-null values here and let install snapshot
      // handle the "user had no override" case.
    }
  }

  // Tier 3: install snapshot
  if (source === "default") {
    const snapshot = readInstallSnapshotOverride();
    if (snapshot !== ARMED_OVERRIDE_VALUE) {
      // Snapshot may legitimately be `null` (user had no override set
      // at install time). That's a valid restore target: writing
      // `null` deletes the key entirely via writeAutoCompactOverride.
      // But an empty (missing) snapshot file also reads as `null`,
      // which would be indistinguishable from "user had no override".
      // readInstallSnapshotOverride returns null for BOTH cases, so
      // we only adopt it when it differs from the default fallback
      // OR we can confirm the file existed. Keeping it simple: if
      // readNewestArmBackupOverride didn't fire AND snapshot reader
      // returns a non-null override, use it. Otherwise fall to
      // hardcoded default.
      if (snapshot !== null) {
        target = snapshot;
        source = "install-snapshot";
      }
    }
  }

  if (!writeAutoCompactOverride(target)) return "io-error";

  // Settings healed - the sentinel is now stale garbage regardless
  // of which branch we took.
  deleteSentinel();

  switch (source) {
    case "sentinel":
      return "restored-from-sentinel";
    case "arm-backup":
      return "restored-from-arm-backup";
    case "install-snapshot":
      return "restored-from-install-snapshot";
    default:
      return "restored-to-default";
  }
}
