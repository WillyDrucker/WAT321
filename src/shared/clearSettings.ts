import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  clearArmBackupRing,
  readInstallSnapshotBytes,
  writeInstallSnapshotBytes,
} from "../WAT321_EXPERIMENTAL_AUTOCOMPACT/backups";
import { healStuckOverride, type HealResult } from "../WAT321_EXPERIMENTAL_AUTOCOMPACT/heal";

const STAMP_DIR = join(homedir(), ".wat321");

/** Every status bar item id we create via `window.createStatusBarItem`.
 * VS Code (1.63+) stores per-item user-hidden state in `settings.json`
 * under `workbench.statusBarItem.<id>.visible`. Reset WAT321 clears
 * those keys so a user who hid a widget via right-click then later
 * hit Reset gets every widget restored, not just the `wat321.*`
 * settings. Keep this list in sync with the widget constructors. */
const STATUS_BAR_ITEM_IDS = [
  "wat321.session",
  "wat321.weekly",
  "wat321.sessionTokens",
  "wat321.codexSession",
  "wat321.codexWeekly",
  "wat321.codexSessionTokens",
  "wat321.claudeAutoCompactArmed",
] as const;

/** Update a single wat321.* setting at every applicable configuration
 * scope. Necessary because `config.get()` returns the merged effective
 * value and a workspace-level override otherwise survives a global-only
 * reset. Pass `undefined` to remove the user-set value and fall back
 * to the schema default; pass `false` (or any concrete value) to
 * force-set to that value at every scope.
 *
 * Global is always updated. Workspace and WorkspaceFolder are only
 * attempted when a workspace folder is actually open, avoiding two
 * guaranteed-to-throw calls on the common case of "no workspace."
 * Each applicable scope update is still individually guarded so a
 * scope that exists but rejects (e.g. read-only settings file) is
 * a silent no-op instead of an unhandled promise rejection. Updates
 * run in parallel via `Promise.all` because they target distinct
 * config scopes and do not need to be serialized. */
async function updateSettingAllScopes(
  key: string,
  value: unknown
): Promise<void> {
  const config = vscode.workspace.getConfiguration("wat321");
  await updateConfigKeyAllScopes(config, key, value);
}

/** Clear a checkbox-style `wat321.*` setting back to unchecked.
 * Uses `config.inspect()` to find the exact scope(s) where the
 * user's `true` lives, then writes an explicit `false` at each
 * of those scopes sequentially with awaits. This reliably lands
 * the underlying config state at `false` across Global /
 * Workspace / WorkspaceFolder.
 *
 * Exported because the experimental auto-compact service clears
 * its own checkbox through this helper too, keeping both the
 * Reset WAT321 flow and the experimental disarm paths on the
 * exact same clearing shape.
 *
 * Note: the Settings UI does not always repaint the visible
 * checkbox row in place after a config.update originating from
 * the row's own tick-origin handler call stack. That is a VS
 * Code rendering bug - scrolling the setting off-screen and back
 * forces a repaint and shows the correct unchecked state. The
 * config value itself is always correct; we cannot fix the stale
 * paint from an extension. */
export async function clearCheckboxSetting(key: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("wat321");
  const inspect = config.inspect<boolean>(key);

  const safeUpdate = async (
    scope: vscode.ConfigurationTarget
  ): Promise<void> => {
    try {
      await config.update(key, false, scope);
    } catch {
      // Scope applicable but update rejected (read-only, etc.).
    }
  };

  let hit = false;
  if (inspect?.globalValue !== undefined) {
    await safeUpdate(vscode.ConfigurationTarget.Global);
    hit = true;
  }
  if (inspect?.workspaceValue !== undefined) {
    await safeUpdate(vscode.ConfigurationTarget.Workspace);
    hit = true;
  }
  if (inspect?.workspaceFolderValue !== undefined) {
    await safeUpdate(vscode.ConfigurationTarget.WorkspaceFolder);
    hit = true;
  }
  // Fallback: nothing was set at any scope (shouldn't happen if the
  // user just ticked the box, but covers Settings UI caches and
  // edge cases where inspect lags behind the UI). Force-write at
  // Global so the visual refresh still fires.
  if (!hit) {
    await safeUpdate(vscode.ConfigurationTarget.Global);
  }
}

/** Same three-scope update pattern as `updateSettingAllScopes`, but
 * takes an already-resolved `WorkspaceConfiguration` so callers can
 * target non-`wat321.*` namespaces (e.g. `workbench.statusBarItem.*`
 * for the Reset-restores-hidden-widgets behavior). */
async function updateConfigKeyAllScopes(
  config: vscode.WorkspaceConfiguration,
  key: string,
  value: unknown
): Promise<void> {
  const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  const targets: vscode.ConfigurationTarget[] = [
    vscode.ConfigurationTarget.Global,
  ];
  if (hasWorkspace) {
    targets.push(
      vscode.ConfigurationTarget.Workspace,
      vscode.ConfigurationTarget.WorkspaceFolder
    );
  }
  await Promise.all(
    targets.map(async (scope) => {
      try {
        await config.update(key, value, scope);
      } catch {
        // Scope applicable but update rejected (read-only, etc.).
      }
    })
  );
}

/** Reset the per-item status-bar visibility for every WAT321 widget.
 * VS Code stores user right-click "Hide" decisions in `settings.json`
 * as `workbench.statusBarItem.<id>.visible = false`. Clearing these
 * to `undefined` restores VS Code's default (visible) so a user who
 * reset WAT321 after hiding a widget gets it back. Scoped narrowly
 * to our six known widget ids - we never touch any other workbench
 * namespace. */
async function resetStatusBarItemVisibility(): Promise<void> {
  const config = vscode.workspace.getConfiguration("workbench");
  await Promise.all(
    STATUS_BAR_ITEM_IDS.map((id) =>
      updateConfigKeyAllScopes(config, `statusBarItem.${id}.visible`, undefined)
    )
  );
}

async function performClear(): Promise<void> {
  // Clear the checkbox back to unchecked at every scope BEFORE
  // showing the confirmation toast. This is the surest way to keep
  // the trigger reliable: a stale `true` at any scope (e.g. left
  // behind by an older build that did not yet have application
  // scope, or by a crashed prior run) would otherwise prevent the
  // checkbox from re-firing the change handler. Clearing first
  // means every click leaves the box unchecked and any subsequent
  // click is guaranteed to register as a fresh transition.
  await clearCheckboxSetting("clearAllData");

  // Non-modal bottom-right notification - keeps the confirmation in
  // VS Code's normal notification area instead of a center-screen
  // modal that blocks the whole UI.
  const confirm = await vscode.window.showWarningMessage(
    "This will reset all WAT321 settings to defaults and clear stored data. If any WAT321 tool appears unresponsive, this will reset every tool back to a known-good state. Continue?",
    "Clear Everything",
    "Cancel"
  );

  if (confirm !== "Clear Everything") return;

  // CRITICAL: before wiping ~/.wat321/, make absolutely sure
  // ~/.claude/settings.json is not stuck at the experimental
  // Force Claude Auto-Compact armed value "1". healStuckOverride
  // inspects settings.json directly (NOT via the sentinel) so it
  // works even if the sentinel is missing, corrupt, or self-
  // referential. It restores to the sentinel's original value if
  // trustworthy, or to "85" (Claude's default auto-compact
  // threshold) as a hardcoded failsafe. This is the reset-as-
  // failsafe guarantee: Reset WAT321 must ALWAYS unstick the user.
  let healResult: HealResult = "not-stuck";
  try {
    healResult = healStuckOverride();
  } catch {
    healResult = "io-error";
  }

  if (healResult === "io-error") {
    await vscode.window.showErrorMessage(
      "WAT321 could not write to ~/.claude/settings.json while trying to heal a stuck CLAUDE_AUTOCOMPACT_PCT_OVERRIDE. Reset aborted so we do not wipe ~/.wat321/ while settings are still at \"1\". Check that the file is not locked or read-only, then run Reset WAT321 again.",
      { modal: true }
    );
    return;
  }

  // Reset all settings to defaults. Must clear at every scope
  // (Global / Workspace / WorkspaceFolder) because `config.get()`
  // returns the merged effective value and a workspace-level
  // override survives a global-only reset. A user who ever set
  // any wat321.* setting via the Workspace tab of the Settings UI
  // or via `.vscode/settings.json` would otherwise see Reset
  // appear to work (setting disappears from the Global view) but
  // the workspace copy silently re-activates the tool on the next
  // extension start. All six keys reset in parallel since they
  // target independent config paths.
  await Promise.all([
    updateSettingAllScopes("enableClaude", undefined),
    updateSettingAllScopes("enableCodex", undefined),
    updateSettingAllScopes("experimental.forceClaudeAutoCompact", undefined),
    updateSettingAllScopes("displayMode", undefined),
    updateSettingAllScopes("statusBarPriority", undefined),
    // Restore any WAT321 status bar items the user hid via right-click.
    // Narrowly scoped to our six known widget ids - see STATUS_BAR_ITEM_IDS.
    resetStatusBarItemVisibility(),
  ]);

  // Clear the arm backup ring explicitly (best-effort) before the
  // recursive wipe. Ring entries are historical user values; a reset
  // is the moment to drop them so they cannot resurrect via the heal
  // chain on the next arm.
  clearArmBackupRing();

  // Preserve the install snapshot across the recursive wipe of
  // ~/.wat321/. The snapshot is the "original install baseline" the
  // user explicitly asked us to keep available as a last-resort
  // restore source even after Reset runs. Read its raw bytes now
  // and rewrite them after the directory is rebuilt.
  const preservedInstallSnapshot = readInstallSnapshotBytes();

  // Remove the entire ~/.wat321/ folder. This catches the active shared
  // caches and claim files, plus any deprecated artifacts from earlier
  // versions (e.g. claude-usage-last-fetch, codex-usage-last-fetch,
  // welcome-shown) that upgraded installs may still be carrying. One
  // recursive remove covers everything WAT321 has ever written. The
  // force-auto-compact sentinel (if any) was already processed above.
  try {
    if (existsSync(STAMP_DIR)) {
      rmSync(STAMP_DIR, { recursive: true, force: true });
    }
  } catch {
    // best-effort
  }

  // Rehydrate the preserved install snapshot so it survives Reset.
  // The next start() will NOT re-capture this file (it still exists
  // on disk), which is exactly the behavior the user asked for: the
  // original install baseline stays stable across resets.
  if (preservedInstallSnapshot) {
    writeInstallSnapshotBytes(preservedInstallSnapshot);
  }

  vscode.window.showInformationMessage(
    "WAT321 settings cleared. All defaults restored."
  );
}

/** Keys that must never live at workspace scope because they are
 * action triggers (click to arm / click to reset) rather than
 * persistent preferences. When any of these is stuck at workspace
 * scope, the change handler's `config.get()` reads the merged
 * effective value and workspace silently overrides user, so clicking
 * the checkbox in user settings never fires. Every key in this list
 * is also declared as `"scope": "application"` in package.json so
 * that new writes cannot land at workspace scope going forward - the
 * heal below is for early-adopter workspaces that still physically
 * have the key in their `.vscode/settings.json` from before the
 * scope tightening. */
const APPLICATION_SCOPE_KEYS = [
  "wat321.clearAllData",
  "wat321.experimental.forceClaudeAutoCompact",
] as const;

/** Surgically strip a set of `wat321.*` keys from a single
 * settings.json file. Uses a conservative line-level regex per key
 * that matches the key at the start of its own line (optional
 * leading whitespace), any bool literal, and an optional trailing
 * comma. Preserves JSONC comments and every other key untouched
 * because we only delete the matching line. Atomic write via
 * tmp+rename so a crash mid-write cannot corrupt the file. Silent
 * no-op on missing file, IO error, or if no matching key is
 * present. */
function stripApplicationScopeKeysFromFile(path: string): void {
  if (!existsSync(path)) return;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }
  if (!APPLICATION_SCOPE_KEYS.some((k) => content.includes(k))) return;

  let next = content;
  for (const key of APPLICATION_SCOPE_KEYS) {
    // Escape any regex metachars in the key so `.` matches literally.
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match the whole line, including its line terminator, so removing
    // it leaves surrounding formatting intact.
    const lineRegex = new RegExp(
      `^[ \\t]*"${escaped}"[ \\t]*:[ \\t]*(?:true|false)[ \\t]*,?[ \\t]*\\r?\\n`,
      "gm"
    );
    next = next.replace(lineRegex, "");
  }
  if (next === content) return;

  // Fix up a trailing comma that used to separate one of our keys
  // from the closing brace: `, \n}` -> `\n}`. Safe at the end of an
  // object literal. Runs after all strips so the final shape is
  // always valid JSONC.
  next = next.replace(/,(\s*})/g, "$1");

  try {
    const tmp = `${path}.wat321-heal.tmp`;
    writeFileSync(tmp, next, "utf8");
    // Atomic rename; on Windows this overwrites the target.
    renameSync(tmp, path);
  } catch {
    // best-effort
  }
}

/** Heal any stale application-scope key left behind by an older
 * WAT321 build (before these settings were tightened to
 * `scope: application`) or by a crashed prior run. Two-pronged:
 *
 *   1. User-scope cleanup via the normal config API. For an
 *      application-scoped setting VS Code will accept a Global write
 *      and silently ignore Workspace/WorkspaceFolder writes; either
 *      way this drops any lingering user-level value back to the
 *      schema default.
 *
 *   2. Direct file surgery on every open workspace folder's
 *      `.vscode/settings.json`. Necessary because VS Code now refuses
 *      to modify application-scoped keys at workspace scope through
 *      the API, which would otherwise leave `"wat321.clearAllData":
 *      false` (or the experimental checkbox) physically present in
 *      the file forever. A stuck workspace value of either true or
 *      false breaks the change handler for these checkboxes
 *      (workspace overrides user during merge, so the handler's
 *      `config.get()` never sees the global transition).
 *
 * Fire-and-forget on activation. Never throws; every IO path is
 * guarded. Scoped narrowly to the keys in `APPLICATION_SCOPE_KEYS` -
 * we never touch any other setting in the file. */
function healStaleApplicationScopeKeys(): void {
  void clearCheckboxSetting("clearAllData").catch(() => {
    // best-effort - never block activation
  });
  void clearCheckboxSetting("experimental.forceClaudeAutoCompact").catch(() => {
    // best-effort - never block activation
  });

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return;
  for (const folder of folders) {
    const settingsPath = join(folder.uri.fsPath, ".vscode", "settings.json");
    stripApplicationScopeKeysFromFile(settingsPath);
  }
}

export function registerClearSettingsCommand(
  context: vscode.ExtensionContext
): void {
  // Heal any stale application-scope keys left behind by an older
  // build or a crashed prior run. Also scrubs the physical
  // .vscode/settings.json of any early-adopter workspace where the
  // keys were saved before they became application-scoped. Covers
  // both `wat321.clearAllData` and `wat321.experimental.forceClaudeAutoCompact`.
  healStaleApplicationScopeKeys();

  // Command palette entry
  context.subscriptions.push(
    vscode.commands.registerCommand("wat321.clearAllSettings", () => performClear())
  );

  // Settings page checkbox trigger. performClear clears the
  // checkbox via clearCheckboxSetting once the confirmation dialog
  // closes - see the comment inside performClear for the Settings
  // UI rendering caveat.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("wat321.clearAllData")) {
        const checked = vscode.workspace
          .getConfiguration("wat321")
          .get<boolean>("clearAllData", false);
        if (checked) performClear();
      }
    })
  );
}
