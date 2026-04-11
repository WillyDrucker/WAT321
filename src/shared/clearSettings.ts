import * as vscode from "vscode";
import { existsSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const STAMP_DIR = join(homedir(), ".wat321");

export function registerClearSettingsCommand(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("wat321.clearAllSettings", async () => {
      const confirm = await vscode.window.showWarningMessage(
        "This will reset all WAT321 settings to defaults and clear stored data. Continue?",
        "Clear Everything",
        "Cancel"
      );

      if (confirm !== "Clear Everything") return;

      // Reset all settings to defaults
      const config = vscode.workspace.getConfiguration("wat321");
      await config.update("enableClaude", undefined, vscode.ConfigurationTarget.Global);
      await config.update("enableCodex", undefined, vscode.ConfigurationTarget.Global);
      await config.update("displayMode", undefined, vscode.ConfigurationTarget.Global);
      await config.update("statusBarPriority", undefined, vscode.ConfigurationTarget.Global);

      // Remove ~/.wat321/ folder
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
    })
  );
}
