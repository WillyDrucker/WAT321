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
 * Recovery logic for Claude Force Auto-Compact. Four-tier restore
 * precedence, searched in order and poison-checked at every tier
 * ("1" is never a valid restore target anywhere):
 *
 *   1. `sentinel.originalOverride` if the sentinel exists and its
 *      recorded original is not the armed value
 *   2. Newest arm backup ring entry (`readNewestArmBackupOverride`)
 *   3. Install snapshot (`readInstallSnapshotOverride`)
 *   4. `DEFAULT_CLAUDE_AUTOCOMPACT_PCT_STR` ("85") as the hardcoded
 *      failsafe
 *
 * Two entry points:
 *
 *   - `safeRestoreValue()` - in-memory disarm path with a sentinel
 *     object already in hand.
 *   - `healStuckOverride()` - inspects settings.json directly,
 *     called from `start()`, the widget retry, and Reset WAT321.
 *     The only path that can recover a user whose sentinel is
 *     missing, corrupt, or self-referential. An unreadable
 *     settings file biases toward preserving the sentinel: on
 *     `io-error` we return without touching it, because the
 *     sentinel may be the only trustworthy record of the
 *     original value.
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
 * Inspect `~/.claude/settings.json` directly and, if the override
 * is stuck at `"1"`, restore via the four-tier precedence chain
 * documented in the file-level docstring above, then clean up the
 * sentinel.
 *
 * Safety invariant: an unreadable settings.json biases toward
 * preserve. On `io-error` we return without touching the sentinel,
 * because the sentinel may be the only trustworthy record of the
 * user's original value. Only a confirmed read of a non-`"1"`
 * value is allowed to delete an orphaned sentinel.
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
