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

let claudeService: ClaudeUsageSharedService | null = null;
let codexService: CodexUsageSharedService | null = null;
let claudeTokenService: ClaudeSessionTokenService | null = null;
let codexTokenService: CodexSessionTokenService | null = null;

export function activate(context: vscode.ExtensionContext) {
  const workspacePath =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const config = vscode.workspace.getConfiguration("wat321");

  // --- Claude tools (default: enabled) ---
  if (config.get<boolean>("enableClaude", true)) {
    claudeService = new ClaudeUsageSharedService();
    activateClaudeUsage5hrTool(context, claudeService);
    activateClaudeUsageWeeklyTool(context, claudeService);

    claudeTokenService = new ClaudeSessionTokenService(workspacePath);
    activateClaudeTokenWidget(context, claudeTokenService);

    context.subscriptions.push(
      { dispose: () => claudeService?.dispose() },
      { dispose: () => claudeTokenService?.dispose() }
    );

    claudeService.start();
    claudeTokenService.start();
  }

  // --- Codex tools (default: disabled) ---
  if (config.get<boolean>("enableCodex", false)) {
    codexService = new CodexUsageSharedService();
    activateCodexUsage5hrTool(context, codexService);
    activateCodexUsageWeeklyTool(context, codexService);

    codexTokenService = new CodexSessionTokenService(workspacePath);
    activateCodexTokenWidget(context, codexTokenService);

    context.subscriptions.push(
      { dispose: () => codexService?.dispose() },
      { dispose: () => codexTokenService?.dispose() }
    );

    codexService.start();
    codexTokenService.start();
  }

  // --- Re-render all widgets immediately when displayMode changes ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("wat321.displayMode")) {
        claudeService?.rebroadcast();
        codexService?.rebroadcast();
        claudeTokenService?.rebroadcast();
        codexTokenService?.rebroadcast();
      }
    })
  );
}

export function deactivate() {
  claudeService?.dispose();
  codexService?.dispose();
  claudeTokenService?.dispose();
  codexTokenService?.dispose();
}
