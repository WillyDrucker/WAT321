import * as vscode from "vscode";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const STAMP_DIR = join(homedir(), ".wat321");
const WELCOME_FLAG = join(STAMP_DIR, "welcome-shown");

export function showWelcomeOnce(): void {
  if (existsSync(WELCOME_FLAG)) return;

  // Write flag immediately so it never shows twice, even if dismissed
  try {
    if (!existsSync(STAMP_DIR)) mkdirSync(STAMP_DIR, { recursive: true });
    writeFileSync(WELCOME_FLAG, String(Date.now()));
  } catch {
    // best-effort - if we can't write the flag, skip the notification
    return;
  }

  vscode.window
    .showInformationMessage(
      "Welcome to WAT321! Claude widgets are active in your status bar. Codex widgets are available but disabled by default.",
      "Enable Codex",
      "Open Settings"
    )
    .then((choice) => {
      if (choice === "Enable Codex") {
        vscode.workspace
          .getConfiguration("wat321")
          .update("enableCodex", true, vscode.ConfigurationTarget.Global);
      } else if (choice === "Open Settings") {
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "wat321"
        );
      }
    });
}
