import * as vscode from "vscode";
import { ClaudeSessionTokenService } from "./WAT321_CLAUDE_SESSION_TOKENS/service";
import { activateClaudeTokenWidget } from "./WAT321_CLAUDE_SESSION_TOKENS/widget";
import { activateClaudeUsage5hrTool } from "./WAT321_CLAUDE_USAGE_5H/tool";
import { activateClaudeUsageWeeklyTool } from "./WAT321_CLAUDE_USAGE_WEEKLY/tool";
import { CodexSessionTokenService } from "./WAT321_CODEX_SESSION_TOKENS/service";
import { activateCodexTokenWidget } from "./WAT321_CODEX_SESSION_TOKENS/widget";
import { activateCodexUsage5hrTool } from "./WAT321_CODEX_USAGE_5H/tool";
import { activateCodexUsageWeeklyTool } from "./WAT321_CODEX_USAGE_WEEKLY/tool";
import { ClaudeForceAutoCompactService } from "./WAT321_CLAUDE_FORCE_AUTOCOMPACT/service";
import {
  activateClaudeForceAutoCompactWidget,
  type ClaudeForceAutoCompactWidget,
} from "./WAT321_CLAUDE_FORCE_AUTOCOMPACT/widget";
import { ClaudeUsageSharedService } from "./shared/claude-usage/service";
import { CodexUsageSharedService } from "./shared/codex-usage/service";
import { providerState } from "./shared/displayMode";

/**
 * Provider activation and teardown. Kept out of `extension.ts` so the
 * top-level entry can stay focused on the VS Code command/config
 * wiring while this file owns the "what gets wired up when a provider
 * is enabled" decisions.
 */

interface ProviderService {
  dispose(): void;
  rebroadcast(): void;
  subscribe(listener: (state: { status: string }) => void): void;
  unsubscribe(listener: (state: { status: string }) => void): void;
}

export interface ProviderGroup {
  disposables: vscode.Disposable[];
  usageService: ProviderService;
  tokenService: { dispose(): void; rebroadcast(): void };
}

export interface ClaudeForceAutoCompactGroup {
  disposables: vscode.Disposable[];
  service: ClaudeForceAutoCompactService;
  widget: ClaudeForceAutoCompactWidget;
}

export interface ActiveGroups {
  claude: ProviderGroup | null;
  codex: ProviderGroup | null;
  claudeForceAutoCompact: ClaudeForceAutoCompactGroup | null;
}

/** Resolve the current workspace path or empty string. */
function workspacePath(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
}

/** Trigger a widget re-render across all currently active services
 * (for Auto display mode recompute after provider activity changes). */
export function rebroadcastAll(groups: ActiveGroups): void {
  groups.claude?.usageService.rebroadcast();
  groups.codex?.usageService.rebroadcast();
  groups.claude?.tokenService.rebroadcast();
  groups.codex?.tokenService.rebroadcast();
}

/** Sync `providerState` with a usage service state change and trigger
 * a rebroadcast when the active flag flips, so Auto display mode
 * recomputes across every widget. */
export function updateProviderActive(
  provider: "claude" | "codex",
  state: { status: string },
  groups: ActiveGroups
): void {
  const active = state.status !== "not-connected";
  const prev =
    provider === "claude"
      ? providerState.claudeActive
      : providerState.codexActive;
  if (prev === active) return;
  if (provider === "claude") providerState.claudeActive = active;
  else providerState.codexActive = active;
  rebroadcastAll(groups);
}

export function activateClaude(groups: ActiveGroups): ProviderGroup {
  const usageService = new ClaudeUsageSharedService();
  const tokenService = new ClaudeSessionTokenService(workspacePath());

  const disposables: vscode.Disposable[] = [
    ...activateClaudeUsage5hrTool(usageService),
    ...activateClaudeUsageWeeklyTool(usageService),
    ...activateClaudeTokenWidget(tokenService),
    { dispose: () => usageService.dispose() },
    { dispose: () => tokenService.dispose() },
  ];

  const stateListener = (state: { status: string }) =>
    updateProviderActive("claude", state, groups);
  usageService.subscribe(stateListener);
  disposables.push({ dispose: () => usageService.unsubscribe(stateListener) });

  usageService.start();
  tokenService.start();

  return { disposables, usageService, tokenService };
}

export function activateCodex(groups: ActiveGroups): ProviderGroup {
  const codexService = new CodexUsageSharedService();
  const tokenService = new CodexSessionTokenService(workspacePath());

  const disposables: vscode.Disposable[] = [
    ...activateCodexUsage5hrTool(codexService),
    ...activateCodexUsageWeeklyTool(codexService),
    ...activateCodexTokenWidget(tokenService),
    { dispose: () => codexService.dispose() },
    { dispose: () => tokenService.dispose() },
  ];

  const stateListener = (state: { status: string }) =>
    updateProviderActive("codex", state, groups);
  codexService.subscribe(stateListener);
  disposables.push({ dispose: () => codexService.unsubscribe(stateListener) });

  codexService.start();
  tokenService.start();

  return { disposables, usageService: codexService, tokenService };
}

/** Dispose a provider group, reset its active flag, and rebroadcast so
 * Auto display mode recomputes across remaining widgets. Returns `null`
 * so callers can write `group = deactivateGroup(group, "claude", groups);`. */
export function deactivateGroup(
  group: ProviderGroup | null,
  provider: "claude" | "codex",
  groups: ActiveGroups
): null {
  if (!group) return null;
  for (const d of group.disposables) d.dispose();
  if (provider === "claude") providerState.claudeActive = false;
  else providerState.codexActive = false;
  rebroadcastAll(groups);
  return null;
}

/** Activate Claude Force Auto-Compact. Requires the Claude group to be
 * already active - the force-compact service subscribes to the Claude
 * token service for the target transcript path and session descriptor. */
export function activateClaudeForceAutoCompact(
  context: vscode.ExtensionContext,
  groups: ActiveGroups
): ClaudeForceAutoCompactGroup | null {
  if (!groups.claude) return null;
  const tokenService =
    groups.claude.tokenService as unknown as ClaudeSessionTokenService;

  const service = new ClaudeForceAutoCompactService();
  const activation = activateClaudeForceAutoCompactWidget(
    service,
    tokenService,
    context
  );
  const disposables: vscode.Disposable[] = [
    ...activation.disposables,
    { dispose: () => service.dispose() },
  ];
  service.start();
  return { disposables, service, widget: activation.widget };
}

export function deactivateClaudeForceAutoCompact(
  group: ClaudeForceAutoCompactGroup | null
): null {
  if (!group) return null;
  for (const d of group.disposables) d.dispose();
  return null;
}
