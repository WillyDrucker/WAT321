import * as vscode from "vscode";

import { activateClaudeUsage5hrTool } from "./WAT321_CLAUDE_USAGE_5H/tool";
import { activateClaudeUsageWeeklyTool } from "./WAT321_CLAUDE_USAGE_WEEKLY/tool";
import { ClaudeUsageSharedService } from "./shared/claude-usage/service";

import { activateCodexUsage5hrTool } from "./WAT321_CODEX_USAGE_5H/tool";
import { activateCodexUsageWeeklyTool } from "./WAT321_CODEX_USAGE_WEEKLY/tool";
import { CodexUsageSharedService } from "./shared/codex-usage/service";

import { ClaudeSessionTokenService } from "./WAT321_CLAUDE_SESSION_TOKENS/service";
import { activateClaudeTokenWidget } from "./WAT321_CLAUDE_SESSION_TOKENS/widget";

import { CodexSessionTokenService } from "./WAT321_CODEX_SESSION_TOKENS/service";
import { activateCodexTokenWidget } from "./WAT321_CODEX_SESSION_TOKENS/widget";

import { showWelcomeOnce } from "./shared/welcome";
import { registerClearSettingsCommand } from "./shared/clearSettings";

interface ProviderGroup {
  disposables: vscode.Disposable[];
  usageService: { dispose(): void; rebroadcast(): void };
  tokenService: { dispose(): void; rebroadcast(): void };
}

let claudeGroup: ProviderGroup | null = null;
let codexGroup: ProviderGroup | null = null;

function activateClaude(): ProviderGroup {
  const workspacePath =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

  const usageService = new ClaudeUsageSharedService();
  const tokenService = new ClaudeSessionTokenService(workspacePath);

  const disposables: vscode.Disposable[] = [
    ...activateClaudeUsage5hrTool(usageService),
    ...activateClaudeUsageWeeklyTool(usageService),
    ...activateClaudeTokenWidget(tokenService),
    { dispose: () => usageService.dispose() },
    { dispose: () => tokenService.dispose() },
  ];

  usageService.start();
  tokenService.start();

  return { disposables, usageService, tokenService };
}

function activateCodex(): ProviderGroup {
  const workspacePath =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

  const codexService = new CodexUsageSharedService();
  const tokenService = new CodexSessionTokenService(workspacePath);

  const disposables: vscode.Disposable[] = [
    ...activateCodexUsage5hrTool(codexService),
    ...activateCodexUsageWeeklyTool(codexService),
    ...activateCodexTokenWidget(tokenService),
    { dispose: () => codexService.dispose() },
    { dispose: () => tokenService.dispose() },
  ];

  codexService.start();
  tokenService.start();

  return { disposables, usageService: codexService, tokenService };
}

function deactivateGroup(group: ProviderGroup | null): null {
  if (!group) return null;
  for (const d of group.disposables) d.dispose();
  return null;
}

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("wat321");

  // --- Initial activation based on current settings ---
  if (config.get<boolean>("enableClaude", true)) {
    claudeGroup = activateClaude();
  }
  if (config.get<boolean>("enableCodex", false)) {
    codexGroup = activateCodex();
  }

  // --- Dynamic enable/disable on settings change ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("wat321.enableClaude")) {
        const enabled = vscode.workspace
          .getConfiguration("wat321")
          .get<boolean>("enableClaude", true);
        if (enabled && !claudeGroup) {
          claudeGroup = activateClaude();
        } else if (!enabled && claudeGroup) {
          claudeGroup = deactivateGroup(claudeGroup);
        }
      }

      if (e.affectsConfiguration("wat321.enableCodex")) {
        const enabled = vscode.workspace
          .getConfiguration("wat321")
          .get<boolean>("enableCodex", false);
        if (enabled && !codexGroup) {
          codexGroup = activateCodex();
        } else if (!enabled && codexGroup) {
          codexGroup = deactivateGroup(codexGroup);
        }
      }

      // Re-render all widgets immediately when display settings change
      if (
        e.affectsConfiguration("wat321.displayMode") ||
        e.affectsConfiguration("wat321.autoCompactThreshold")
      ) {
        claudeGroup?.usageService.rebroadcast();
        codexGroup?.usageService.rebroadcast();
        claudeGroup?.tokenService.rebroadcast();
        codexGroup?.tokenService.rebroadcast();
      }
    })
  );

  // --- First-run welcome notification ---
  showWelcomeOnce();

  // --- Command palette ---
  registerClearSettingsCommand(context);
}

export function deactivate() {
  claudeGroup = deactivateGroup(claudeGroup);
  codexGroup = deactivateGroup(codexGroup);
}
