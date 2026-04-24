import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";
import {
  deleteAllCodexSessions,
  deleteCurrentCodexSession,
} from "./deleteCommand";
import { stageClipboardImageCommand } from "./stageClipboardImage";
import {
  loadBridgeThreadRecord,
  resetBridgeThread,
} from "./threadPersistence";
import type { EpicHandshakeLogger } from "./types";

/**
 * Command palette registration. Each command is a thin shim over a
 * tier-level operation; pulled out of the tier class so the lifecycle
 * shell stays focused on activate/deactivate plumbing rather than
 * per-command boilerplate.
 *
 * `refreshStatusBar` threads state from the tier through here; we do
 * not import the tier class itself to keep the dependency one-
 * directional.
 */

export interface CommandRegistrationDeps {
  logger: EpicHandshakeLogger;
  refreshStatusBar: () => void;
}

export function registerEpicHandshakeCommands(
  deps: CommandRegistrationDeps
): vscode.Disposable[] {
  const { logger, refreshStatusBar } = deps;
  return [
    vscode.commands.registerCommand("wat321.epicHandshake.enable", async () => {
      await vscode.workspace
        .getConfiguration("wat321")
        .update(
          SETTING.epicHandshakeEnabled,
          true,
          vscode.ConfigurationTarget.Global
        );
    }),
    vscode.commands.registerCommand(
      "wat321.epicHandshake.disable",
      async () => {
        await vscode.workspace
          .getConfiguration("wat321")
          .update(
            SETTING.epicHandshakeEnabled,
            false,
            vscode.ConfigurationTarget.Global
          );
      }
    ),
    vscode.commands.registerCommand(
      "wat321.epicHandshake.resetCodexSession",
      async () => {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (ws === undefined) {
          void vscode.window.showWarningMessage(
            "Epic Handshake: no workspace folder open."
          );
          return;
        }
        const current = loadBridgeThreadRecord(ws);
        const nextCounter = current.sessionCounter + 1;
        const confirm = await vscode.window.showInformationMessage(
          `Roll Codex to the next session? The current session stays visible in Codex's history. Next Claude to Codex prompt spawns a fresh S${nextCounter}.`,
          "Reset",
          "Cancel"
        );
        if (confirm !== "Reset") return;
        const next = resetBridgeThread(ws);
        refreshStatusBar();
        void vscode.window.showInformationMessage(
          `Epic Handshake: Codex session reset. Next Claude to Codex prompt spawns S${next.sessionCounter}.`
        );
        logger.info(`codex session reset -> S${next.sessionCounter}`);
      }
    ),
    vscode.commands.registerCommand(
      "wat321.epicHandshake.deleteCodexSession",
      async () => {
        await deleteCurrentCodexSession(logger);
        refreshStatusBar();
      }
    ),
    vscode.commands.registerCommand(
      "wat321.epicHandshake.deleteAllCodexSessions",
      async () => {
        await deleteAllCodexSessions(logger);
        refreshStatusBar();
      }
    ),
    vscode.commands.registerCommand(
      "wat321.epicHandshake.stageClipboardImage",
      async () => {
        await stageClipboardImageCommand(logger);
      }
    ),
  ];
}
