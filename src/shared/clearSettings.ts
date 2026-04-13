import * as vscode from "vscode";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeForceAutoCompactService } from "../WAT321_CLAUDE_FORCE_AUTOCOMPACT/service";
import {
  clearArmBackupRing,
  readInstallSnapshotBytes,
  writeInstallSnapshotBytes,
} from "../WAT321_CLAUDE_FORCE_AUTOCOMPACT/backups";
import type { HealResult } from "../WAT321_CLAUDE_FORCE_AUTOCOMPACT/heal";
import { clearConsent } from "./consent";

const STAMP_DIR = join(homedir(), ".wat321");

async function performClear(context: vscode.ExtensionContext): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    "This will reset all WAT321 settings to defaults and clear stored data. If any WAT321 tool appears unresponsive, this will reset every tool back to a known-good state. Continue?",
    "Clear Everything",
    "Cancel"
  );

  if (confirm !== "Clear Everything") {
    // User cancelled - reset the checkbox back to false
    await vscode.workspace
      .getConfiguration("wat321")
      .update("clearAllData", false, vscode.ConfigurationTarget.Global);
    return;
  }

  // CRITICAL: before wiping ~/.wat321/, make absolutely sure
  // ~/.claude/settings.json is not stuck at the Claude Force Auto-Compact
  // armed value "1". healStuckOverride inspects settings.json directly
  // (NOT via the sentinel) so it works even if the sentinel is missing,
  // corrupt, or self-referential. It restores to the sentinel's original
  // value if trustworthy, or to "85" (Claude's default auto-compact
  // threshold) as a hardcoded failsafe. This is the reset-as-failsafe
  // guarantee: Reset WAT321 must ALWAYS unstick the user.
  let healResult: HealResult = "not-stuck";
  try {
    healResult = ClaudeForceAutoCompactService.healStuckOverride();
  } catch {
    healResult = "io-error";
  }

  if (healResult === "io-error") {
    await vscode.workspace
      .getConfiguration("wat321")
      .update("clearAllData", false, vscode.ConfigurationTarget.Global);
    await vscode.window.showErrorMessage(
      "WAT321 could not write to ~/.claude/settings.json while trying to heal a stuck CLAUDE_AUTOCOMPACT_PCT_OVERRIDE. Reset aborted so we do not wipe ~/.wat321/ while settings are still at \"1\". Check that the file is not locked or read-only, then run Reset WAT321 again.",
      { modal: true }
    );
    return;
  }

  // Reset all settings to defaults
  const config = vscode.workspace.getConfiguration("wat321");
  await config.update("enableClaude", undefined, vscode.ConfigurationTarget.Global);
  await config.update("enableCodex", undefined, vscode.ConfigurationTarget.Global);
  await config.update("enableClaudeForceAutoCompact", undefined, vscode.ConfigurationTarget.Global);
  await config.update("displayMode", undefined, vscode.ConfigurationTarget.Global);
  await config.update("statusBarPriority", undefined, vscode.ConfigurationTarget.Global);
  await config.update("clearAllData", false, vscode.ConfigurationTarget.Global);

  // Clear persisted consent records so re-enabling an interactive tool
  // re-prompts the user. Symmetric with the settings reset.
  await clearConsent(context, "claudeForceAutoCompact");

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

export function registerClearSettingsCommand(
  context: vscode.ExtensionContext
): void {
  // Command palette entry
  context.subscriptions.push(
    vscode.commands.registerCommand("wat321.clearAllSettings", () => performClear(context))
  );

  // Settings page checkbox trigger
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("wat321.clearAllData")) {
        const checked = vscode.workspace
          .getConfiguration("wat321")
          .get<boolean>("clearAllData", false);
        if (checked) performClear(context);
      }
    })
  );
}
