import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  clearArmBackupRing,
  readInstallSnapshotBytes,
  writeInstallSnapshotBytes,
} from "../WAT321_EXPERIMENTAL_AUTOCOMPACT/backups";
import { healStuckOverride, type HealResult } from "../WAT321_EXPERIMENTAL_AUTOCOMPACT/heal";
import { healStaleApplicationScopeKeys } from "./applicationScopeHeal";

const WAT321_DIR = join(homedir(), ".wat321");

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

/** Optional hook fired after the user confirms Reset WAT321 and
 * after the stuck-override heal runs, but before any setting writes
 * or disk wipes. Used to clear in-memory state on running services
 * that `rmSync(~/.wat321/)` cannot reach - currently the kickstart
 * escalation counters on both usage services. Never blocks the
 * reset flow; failures in the callback are not awaited. */
type OnResetCallback = () => void;

async function performClear(onReset?: OnResetCallback): Promise<void> {
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

  // In-memory reset hook: clears kickstart escalation counters on
  // running services so a user trapped in a sustained outage gets
  // the responsive fresh-park cadence back immediately. Runs after
  // the stuck-override heal (so any hard-fail aborts before this)
  // and before the setting writes below (so no user-visible churn
  // overlaps). Gating is preserved - the hook only zeroes the
  // counter and shrinks the poll interval; it does not force a
  // fetch. Never awaited; handler errors do not block reset.
  try {
    onReset?.();
  } catch {
    // Silent - reset flow must not fail because an in-memory hook
    // threw.
  }

  // Reset all settings to defaults. Must clear at every scope
  // (Global / Workspace / WorkspaceFolder) because `config.get()`
  // returns the merged effective value and a workspace-level
  // override survives a global-only reset. A user who ever set
  // any wat321.* setting via the Workspace tab of the Settings UI
  // or via `.vscode/settings.json` would otherwise see Reset
  // appear to work (setting disappears from the Global view) but
  // the workspace copy silently re-activates the tool on the next
  // extension start. All keys reset in parallel since they target
  // independent config paths.
  await Promise.all([
    updateSettingAllScopes("enableClaude", undefined),
    updateSettingAllScopes("enableCodex", undefined),
    updateSettingAllScopes("experimental.forceClaudeAutoCompact", undefined),
    updateSettingAllScopes("displayMode", undefined),
    updateSettingAllScopes("statusBarPriority", undefined),
    updateSettingAllScopes("enableHeatmap", undefined),
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
    if (existsSync(WAT321_DIR)) {
      rmSync(WAT321_DIR, { recursive: true, force: true });
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

export function registerClearSettingsCommand(
  context: vscode.ExtensionContext,
  onReset?: OnResetCallback
): void {
  // Heal any stale application-scope keys left behind by an older
  // build or a crashed prior run. Also scrubs the physical
  // .vscode/settings.json of any early-adopter workspace where the
  // keys were saved before they became application-scoped. Covers
  // both `wat321.clearAllData` and `wat321.experimental.forceClaudeAutoCompact`.
  healStaleApplicationScopeKeys();

  // Command palette entry
  context.subscriptions.push(
    vscode.commands.registerCommand("wat321.clearAllSettings", () => performClear(onReset))
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
        if (checked) performClear(onReset);
      }
    })
  );
}
