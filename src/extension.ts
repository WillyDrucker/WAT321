import * as vscode from "vscode";

import { activateClaudeUsage5hTool } from "./WAT321_CLAUDE_USAGE_5H/tool";
import { activateClaudeUsageWeeklyTool } from "./WAT321_CLAUDE_USAGE_WEEKLY/tool";
import { ClaudeUsageSharedService } from "./shared/claude-usage/service";

import { activateCodexUsage5hTool } from "./WAT321_CODEX_USAGE_5H/tool";
import { activateCodexUsageWeeklyTool } from "./WAT321_CODEX_USAGE_WEEKLY/tool";
import { CodexUsageSharedService } from "./shared/codex-usage/service";

import { SessionTokenService } from "./claude-session-tokens/sessionService";
import { activateTokenWidget } from "./claude-session-tokens/widgets/tokenWidget";

let claudeService: ClaudeUsageSharedService;
let codexService: CodexUsageSharedService;
let tokenService: SessionTokenService;

export function activate(context: vscode.ExtensionContext) {
  const workspacePath =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

  // --- Claude usage (one shared poller, two widgets) ---
  claudeService = new ClaudeUsageSharedService();
  activateClaudeUsage5hTool(context, claudeService);
  activateClaudeUsageWeeklyTool(context, claudeService);

  // --- Codex usage (one shared poller, two widgets) ---
  codexService = new CodexUsageSharedService();
  activateCodexUsage5hTool(context, codexService, "wat321.codexRefresh");
  activateCodexUsageWeeklyTool(context, codexService, "wat321.codexRefresh");

  // --- Claude session tokens ---
  tokenService = new SessionTokenService(workspacePath);
  activateTokenWidget(context, tokenService);

  context.subscriptions.push(
    { dispose: () => claudeService.dispose() },
    { dispose: () => codexService.dispose() },
    { dispose: () => tokenService.dispose() }
  );

  claudeService.start();
  codexService.start();
  tokenService.start();
}

export function deactivate() {
  claudeService?.dispose();
  codexService?.dispose();
  tokenService?.dispose();
}
