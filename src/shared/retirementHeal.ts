/**
 * Temporary retirement heal for the experimental Force Auto-Compact
 * feature removed in v1.1.3. Cleans up artifacts that may remain on
 * user machines from prior versions:
 *
 * - Stuck CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in ~/.claude/settings.json
 * - Sentinel file at ~/.wat321/claude-force-auto-compact-sentinel.json
 * - Orphaned wat321.experimental.forceClaudeAutoCompact VS Code setting
 * - Stale armed-widget visibility in workbench settings
 *
 * Runs silently on activation and on Reset WAT321. Designed to be
 * removed entirely once the cleanup window has passed.
 *
 * TEMPORARY - remove this file and its call sites when retiring.
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { WAT321_DIR } from "../engine/settingsKeys";
import { SETTINGS_PATH, readAutoCompactOverride } from "./claudeSettings";

const SENTINEL_PATH = join(
  WAT321_DIR,
  "claude-force-auto-compact-sentinel.json"
);

/** Legacy hardcoded override from v1.0.14. No user would intentionally
 * set auto-compact to 1% - safe to remove without sentinel guidance. */
const LEGACY_STUCK_VALUE = "1";

/**
 * Run all retirement cleanup tasks. Silent, idempotent, best-effort.
 * Safe to call from activate() (fire-and-forget) and from Reset WAT321.
 */
export function runRetirementHeal(): void {
  try {
    healClaudeSettingsOverride();
  } catch {
    // best-effort
  }
  try {
    deleteSentinel();
  } catch {
    // best-effort
  }
  try {
    clearOrphanedVsCodeSettings();
  } catch {
    // best-effort
  }
}

/**
 * Remove or restore CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in settings.json.
 *
 * Strategy:
 * - Sentinel exists: restore the user's original value from sentinel
 *   (null = delete the key, string = set to that value)
 * - No sentinel, value is "1" (legacy stuck): delete the key
 * - No sentinel, value is anything else: leave it (could be user-set)
 */
function healClaudeSettingsOverride(): void {
  const sentinel = readSentinel();
  const current = readAutoCompactOverride();

  if (current.kind !== "present") return;

  if (sentinel) {
    if (sentinel.originalOverride === null) {
      // User had no override before arming - remove the stuck key.
      if (current.value !== null) {
        removeOverrideFromSettings();
      }
    } else {
      // User had a custom override - restore it.
      if (current.value !== sentinel.originalOverride) {
        writeOverrideToSettings(sentinel.originalOverride);
      }
    }
  } else {
    // No sentinel guidance - only heal the known-bad legacy value.
    if (current.value === LEGACY_STUCK_VALUE) {
      removeOverrideFromSettings();
    }
  }
}

/** Read just the fields we need from the sentinel file. Returns null
 * if the file is absent, unreadable, or has an unexpected format. */
function readSentinel(): { originalOverride: string | null } | null {
  if (!existsSync(SENTINEL_PATH)) return null;
  try {
    const raw = readFileSync(SENTINEL_PATH, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (data.version !== 1) return null;
    const orig = data.originalOverride;
    return {
      originalOverride: typeof orig === "string" ? orig : null,
    };
  } catch {
    return null;
  }
}

function deleteSentinel(): void {
  if (existsSync(SENTINEL_PATH)) {
    rmSync(SENTINEL_PATH, { force: true });
  }
}

/** Delete CLAUDE_AUTOCOMPACT_PCT_OVERRIDE from the env block in
 * ~/.claude/settings.json. Uses atomic temp+rename. */
function removeOverrideFromSettings(): void {
  if (!existsSync(SETTINGS_PATH)) return;
  const raw = readFileSync(SETTINGS_PATH, "utf8");
  const settings = JSON.parse(raw) as Record<string, unknown>;
  const env = settings.env as Record<string, unknown> | undefined;
  if (!env || !("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE" in env)) return;

  delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  if (Object.keys(env).length === 0) delete settings.env;

  atomicWriteSettings(settings);
}

/** Set CLAUDE_AUTOCOMPACT_PCT_OVERRIDE to a specific value in
 * ~/.claude/settings.json. Uses atomic temp+rename. */
function writeOverrideToSettings(value: string): void {
  if (!existsSync(SETTINGS_PATH)) return;
  const raw = readFileSync(SETTINGS_PATH, "utf8");
  const settings = JSON.parse(raw) as Record<string, unknown>;

  if (!settings.env || typeof settings.env !== "object") {
    settings.env = {};
  }
  (settings.env as Record<string, unknown>).CLAUDE_AUTOCOMPACT_PCT_OVERRIDE =
    value;

  atomicWriteSettings(settings);
}

/** Write settings.json via temp file + rename for crash safety. */
function atomicWriteSettings(settings: Record<string, unknown>): void {
  const content = JSON.stringify(settings, null, 2) + "\n";
  const tmp = SETTINGS_PATH + ".wat321-heal.tmp";
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, SETTINGS_PATH);
  } catch {
    // Rename can fail on Windows if the target is locked. Fall back
    // to direct write - still better than leaving a stuck override.
    writeFileSync(SETTINGS_PATH, content, "utf8");
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/** Clear orphaned VS Code settings left from the retired feature.
 * Fire-and-forget - rejections are swallowed. */
function clearOrphanedVsCodeSettings(): void {
  // Orphaned checkbox (definition removed from package.json in v1.1.3)
  const wat = vscode.workspace.getConfiguration("wat321");
  const expInspect = wat.inspect<boolean>(
    "experimental.forceClaudeAutoCompact"
  );
  clearAtAllScopes(wat, "experimental.forceClaudeAutoCompact", expInspect);

  // Stale status bar visibility for the removed armed widget
  const wb = vscode.workspace.getConfiguration("workbench");
  const visKey = "statusBarItem.wat321.claudeAutoCompactArmed.visible";
  const visInspect = wb.inspect<boolean>(visKey);
  clearAtAllScopes(wb, visKey, visInspect);
}

/** Remove a setting at every scope where it exists. */
function clearAtAllScopes(
  config: vscode.WorkspaceConfiguration,
  key: string,
  inspect: ReturnType<vscode.WorkspaceConfiguration["inspect"]> | undefined
): void {
  if (!inspect) return;
  const scopes: [unknown, vscode.ConfigurationTarget][] = [
    [inspect.globalValue, vscode.ConfigurationTarget.Global],
    [inspect.workspaceValue, vscode.ConfigurationTarget.Workspace],
    [inspect.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
  ];
  for (const [val, scope] of scopes) {
    if (val !== undefined) {
      config.update(key, undefined, scope).then(undefined, () => {});
    }
  }
}
