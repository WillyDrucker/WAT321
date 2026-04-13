import * as vscode from "vscode";
import { existsSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ClaudeForceAutoCompactService } from "../WAT321_CLAUDE_FORCE_AUTOCOMPACT/service";
import { clearConsent } from "./consent";

const STAMP_DIR = join(homedir(), ".wat321");

async function performClear(context: vscode.ExtensionContext): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    "This will reset all WAT321 settings to defaults and clear stored data. Continue?",
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

  // CRITICAL: if Claude Force Auto-Compact is armed, restore the user's original
  // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE BEFORE we wipe ~/.wat321/. The
  // sentinel file is the only record of the original value, so if the
  // restore FAILS we must abort the reset entirely rather than delete
  // the sentinel and strand the user at override=1.
  let sentinelResult: "no-sentinel" | "restored" | "restore-failed" = "no-sentinel";
  try {
    sentinelResult = ClaudeForceAutoCompactService.restoreSentinelIfPresent();
  } catch {
    sentinelResult = "restore-failed";
  }

  if (sentinelResult === "restore-failed") {
    await vscode.workspace
      .getConfiguration("wat321")
      .update("clearAllData", false, vscode.ConfigurationTarget.Global);
    await vscode.window.showErrorMessage(
      "WAT321 could not restore your CLAUDE_AUTOCOMPACT_PCT_OVERRIDE from the Claude Force Auto-Compact sentinel. Reset aborted - your sentinel at ~/.wat321/claude-force-auto-compact-sentinel.json is preserved as the only record of your original value. Fix ~/.claude/settings.json manually (either restore the original value and delete the sentinel, or retry from the Claude Force Auto-Compact widget) and then run Reset WAT321 again.",
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
