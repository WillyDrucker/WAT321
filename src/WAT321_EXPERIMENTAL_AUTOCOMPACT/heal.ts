import { existsSync, readFileSync } from "node:fs";
import type { ExperimentalAutoCompactSentinel } from "./types";
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
 * Recovery logic for the experimental Force Claude Auto-Compact.
 * Four-tier restore precedence, searched in order and poison-checked
 * at every tier ("1" is never a valid restore target anywhere):
 *
 *   1. `sentinel.originalOverride` if the sentinel exists and its
 *      recorded original is not the armed value
 *   2. Newest arm backup ring entry
 *   3. Install snapshot
 *   4. `DEFAULT_CLAUDE_AUTOCOMPACT_PCT_STR` ("85") as the hardcoded
 *      failsafe
 *
 * Two entry points:
 *
 *   - `safeRestoreValue()` - in-memory disarm path with a sentinel
 *     object already in hand.
 *   - `healStuckOverride()` - inspects settings.json directly,
 *     called from `start()` and Reset WAT321. The only path that can
 *     recover a user whose sentinel is missing, corrupt, or
 *     self-referential. An unreadable settings file biases toward
 *     preserving the sentinel: on `io-error` we return without
 *     touching it, because the sentinel may be the only trustworthy
 *     record of the original value.
 */

export { ARMED_OVERRIDE_VALUE };

/** Never restore the override to the armed value. If the caller
 * passes "1" as the "original", treat the sentinel as corrupt and
 * substitute the Claude default. `null` (key unset) is valid and
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
 * Inspect `~/.claude/settings.json` directly and, if the override is
 * stuck at `"1"`, restore via the four-tier precedence chain, then
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

  let target: string | null = DEFAULT_CLAUDE_AUTOCOMPACT_PCT_STR;
  let source: "sentinel" | "arm-backup" | "install-snapshot" | "default" =
    "default";

  // Tier 1: sentinel
  try {
    if (existsSync(SENTINEL_PATH)) {
      const raw = readFileSync(SENTINEL_PATH, "utf8");
      const sentinel = JSON.parse(raw) as Partial<ExperimentalAutoCompactSentinel>;
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
    // fall through
  }

  // Tier 2: newest arm backup ring entry
  if (source === "default") {
    const armBackup = readNewestArmBackupOverride();
    if (armBackup !== ARMED_OVERRIDE_VALUE && armBackup !== null) {
      target = armBackup;
      source = "arm-backup";
    }
  }

  // Tier 3: install snapshot
  if (source === "default") {
    const snapshot = readInstallSnapshotOverride();
    if (snapshot !== ARMED_OVERRIDE_VALUE && snapshot !== null) {
      target = snapshot;
      source = "install-snapshot";
    }
  }

  if (!writeAutoCompactOverride(target)) return "io-error";

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
