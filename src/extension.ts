import * as vscode from "vscode";

import { activateClaudeUsage5hrTool } from "./WAT321_CLAUDE_USAGE_5H/tool";
import { activateClaudeUsageWeeklyTool } from "./WAT321_CLAUDE_USAGE_WEEKLY/tool";
import { ClaudeUsageSharedService } from "./shared/claude-usage/service";

import { activateCodexUsage5hrTool } from "./WAT321_CODEX_USAGE_5H/tool";
import { activateCodexUsageWeeklyTool } from "./WAT321_CODEX_USAGE_WEEKLY/tool";
import { CodexUsageSharedService } from "./shared/codex-usage/service";

import { ClaudeSessionTokenService } from "./claude-session-tokens/sessionService";
import { activateClaudeTokenWidget } from "./claude-session-tokens/widgets/tokenWidget";

import { CodexSessionTokenService } from "./WAT321_CODEX_SESSION_TOKENS/service";
import { activateCodexTokenWidget } from "./WAT321_CODEX_SESSION_TOKENS/widget";

import { showWelcomeOnce } from "./shared/welcome";

interface ProviderGroup {
  disposables: vscode.Disposable[];
  usageService?: { dispose(): void; rebroadcast(): void };
  tokenService?: { dispose(): void; rebroadcast(): void };
}

let claudeGroup: ProviderGroup | null = null;
let codexGroup: ProviderGroup | null = null;

function activateClaude(context: vscode.ExtensionContext): ProviderGroup {
  const workspacePath =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const disposables: vscode.Disposable[] = [];

  const usageService = new ClaudeUsageSharedService();
  activateClaudeUsage5hrTool(context, usageService);
  activateClaudeUsageWeeklyTool(context, usageService);

  const tokenService = new ClaudeSessionTokenService(workspacePath);
  activateClaudeTokenWidget(context, tokenService);

  usageService.start();
  tokenService.start();

  disposables.push(
    { dispose: () => usageService.dispose() },
    { dispose: () => tokenService.dispose() }
  );

  return { disposables, usageService, tokenService };
}

function activateCodex(context: vscode.ExtensionContext): ProviderGroup {
  const workspacePath =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const disposables: vscode.Disposable[] = [];

  const usageService = new CodexUsageSharedService();
  activateCodexUsage5hrTool(context, usageService);
  activateCodexUsageWeeklyTool(context, usageService);

  const tokenService = new CodexSessionTokenService(workspacePath);
  activateCodexTokenWidget(context, tokenService);

  usageService.start();
  tokenService.start();

  disposables.push(
    { dispose: () => usageService.dispose() },
    { dispose: () => tokenService.dispose() }
  );

  return { disposables, usageService, tokenService };
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
    claudeGroup = activateClaude(context);
  }
  if (config.get<boolean>("enableCodex", false)) {
    codexGroup = activateCodex(context);
  }

  // --- Dynamic enable/disable on settings change ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("wat321.enableClaude")) {
        const enabled = vscode.workspace
          .getConfiguration("wat321")
          .get<boolean>("enableClaude", true);
        if (enabled && !claudeGroup) {
          claudeGroup = activateClaude(context);
        } else if (!enabled && claudeGroup) {
          claudeGroup = deactivateGroup(claudeGroup);
        }
      }

      if (e.affectsConfiguration("wat321.enableCodex")) {
        const enabled = vscode.workspace
          .getConfiguration("wat321")
          .get<boolean>("enableCodex", false);
        if (enabled && !codexGroup) {
          codexGroup = activateCodex(context);
        } else if (!enabled && codexGroup) {
          codexGroup = deactivateGroup(codexGroup);
        }
      }

      // Re-render all widgets immediately when displayMode changes
      if (e.affectsConfiguration("wat321.displayMode")) {
        claudeGroup?.usageService?.rebroadcast();
        codexGroup?.usageService?.rebroadcast();
        claudeGroup?.tokenService?.rebroadcast();
        codexGroup?.tokenService?.rebroadcast();
      }
    })
  );

  // --- First-run welcome notification ---
  showWelcomeOnce();
}

export function deactivate() {
  claudeGroup = deactivateGroup(claudeGroup);
  codexGroup = deactivateGroup(codexGroup);
}
