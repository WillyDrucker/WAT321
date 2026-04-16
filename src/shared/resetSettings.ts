import { existsSync, rmSync } from "node:fs";
import * as vscode from "vscode";
import { SETTING, WAT321_DIR } from "../engine/settingsKeys";
import { getAllWidgetIds } from "../engine/widgetCatalog";
import { healStaleApplicationScopeKeys } from "./workspaceScopeHeal";
import { runRetirementHeal } from "./retirementHeal";

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
 * Exported for any action-trigger checkbox that needs clearing
 * across all scopes.
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
 * to our WAT321 widget ids - we never touch any other workbench
 * namespace. */
async function resetStatusBarItemVisibility(): Promise<void> {
  const config = vscode.workspace.getConfiguration("workbench");
  await Promise.all(
    getAllWidgetIds().map((id) =>
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
  // Clear the checkbox at every scope BEFORE the confirmation toast
  // so a stale `true` at any scope cannot prevent re-firing.
  await clearCheckboxSetting(SETTING.clearAllData);

  // Non-modal bottom-right notification - keeps the confirmation in
  // VS Code's normal notification area instead of a center-screen
  // modal that blocks the whole UI.
  const confirm = await vscode.window.showWarningMessage(
    "This will reset all WAT321 settings to defaults and clear stored data. If any WAT321 tool appears unresponsive, this will reset every tool back to a known-good state. Continue?",
    "Clear Everything",
    "Cancel"
  );

  if (confirm !== "Clear Everything") return;

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

  // Temporary: clean up retired auto-compact artifacts. Must run
  // before rmSync(~/.wat321/) so the sentinel file is still readable
  // for guided restoration of ~/.claude/settings.json.
  runRetirementHeal();

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
    updateSettingAllScopes(SETTING.enableClaude, undefined),
    updateSettingAllScopes(SETTING.enableCodex, undefined),
    updateSettingAllScopes(SETTING.displayMode, undefined),
    updateSettingAllScopes(SETTING.statusBarPriority, undefined),
    updateSettingAllScopes(SETTING.enableHeatmap, undefined),
    updateSettingAllScopes(SETTING.notificationsMode, undefined),
    updateSettingAllScopes(SETTING.notificationsClaude, undefined),
    updateSettingAllScopes(SETTING.notificationsCodex, undefined),
    resetStatusBarItemVisibility(),
  ]);

  // Remove the entire ~/.wat321/ folder. This catches the active shared
  // caches and claim files, plus any deprecated artifacts from earlier
  // versions. One recursive remove covers everything WAT321 has ever
  // written.
  try {
    if (existsSync(WAT321_DIR)) {
      rmSync(WAT321_DIR, { recursive: true, force: true });
    }
  } catch {
    // best-effort
  }

  vscode.window.showInformationMessage(
    "WAT321 settings cleared. All defaults restored."
  );
}

export function registerClearSettingsCommand(
  context: vscode.ExtensionContext,
  onReset?: OnResetCallback
): void {
  // Heal stale application-scope keys from .vscode/settings.json
  // that could block the checkbox change handler.
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
      if (e.affectsConfiguration(`wat321.${SETTING.clearAllData}`)) {
        const checked = vscode.workspace
          .getConfiguration("wat321")
          .get<boolean>(SETTING.clearAllData, false);
        if (checked) performClear(onReset);
      }
    })
  );
}
