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

import { ClaudeForceAutoCompactService } from "./WAT321_CLAUDE_FORCE_AUTOCOMPACT/service";
import {
  activateClaudeForceAutoCompactWidget,
  registerClaudeForceAutoCompactCommand,
} from "./WAT321_CLAUDE_FORCE_AUTOCOMPACT/widget";
import type { ClaudeForceAutoCompactWidget } from "./WAT321_CLAUDE_FORCE_AUTOCOMPACT/widget";

import { registerClearSettingsCommand } from "./shared/clearSettings";
import { providerState } from "./shared/displayMode";

interface ProviderGroup {
  disposables: vscode.Disposable[];
  usageService: {
    dispose(): void;
    rebroadcast(): void;
    subscribe(listener: (state: { status: string }) => void): void;
    unsubscribe(listener: (state: { status: string }) => void): void;
  };
  tokenService: { dispose(): void; rebroadcast(): void };
}

let claudeGroup: ProviderGroup | null = null;
let codexGroup: ProviderGroup | null = null;

interface ClaudeForceAutoCompactGroup {
  disposables: vscode.Disposable[];
  service: ClaudeForceAutoCompactService;
  widget: ClaudeForceAutoCompactWidget;
}
let claudeForceAutoCompactGroup: ClaudeForceAutoCompactGroup | null = null;

/** Trigger a widget re-render across all services (for Auto display mode recompute). */
function rebroadcastAll(): void {
  claudeGroup?.usageService.rebroadcast();
  codexGroup?.usageService.rebroadcast();
  claudeGroup?.tokenService.rebroadcast();
  codexGroup?.tokenService.rebroadcast();
}

/** Update providerState based on a usage service state change and trigger recompute if needed. */
function updateProviderActive(provider: "claude" | "codex", state: { status: string }): void {
  const active = state.status !== "not-connected";
  const prev = provider === "claude" ? providerState.claudeActive : providerState.codexActive;
  if (prev === active) return;
  if (provider === "claude") providerState.claudeActive = active;
  else providerState.codexActive = active;
  // Provider activity changed - recompute Auto display mode across all widgets
  rebroadcastAll();
}

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

  const stateListener = (state: { status: string }) => updateProviderActive("claude", state);
  usageService.subscribe(stateListener);
  disposables.push({ dispose: () => usageService.unsubscribe(stateListener) });

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

  const stateListener = (state: { status: string }) => updateProviderActive("codex", state);
  codexService.subscribe(stateListener);
  disposables.push({ dispose: () => codexService.unsubscribe(stateListener) });

  codexService.start();
  tokenService.start();

  return { disposables, usageService: codexService, tokenService };
}

function deactivateGroup(group: ProviderGroup | null, provider: "claude" | "codex"): null {
  if (!group) return null;
  for (const d of group.disposables) d.dispose();
  // Reset provider activity so Auto display mode recomputes
  if (provider === "claude") providerState.claudeActive = false;
  else providerState.codexActive = false;
  rebroadcastAll();
  return null;
}

function activateClaudeForceAutoCompact(context: vscode.ExtensionContext): ClaudeForceAutoCompactGroup | null {
  // Force-compact depends on the Claude session token service for the
  // target transcript path and session descriptor, so Claude must be
  // enabled and already activated before we wire this up.
  if (!claudeGroup) return null;
  const tokenService = claudeGroup.tokenService as unknown as ClaudeSessionTokenService;

  const service = new ClaudeForceAutoCompactService();
  const activation = activateClaudeForceAutoCompactWidget(service, tokenService, context);
  const disposables: vscode.Disposable[] = [
    ...activation.disposables,
    { dispose: () => service.dispose() },
  ];
  service.start();
  return { disposables, service, widget: activation.widget };
}

function deactivateClaudeForceAutoCompact(): null {
  if (!claudeForceAutoCompactGroup) return null;
  for (const d of claudeForceAutoCompactGroup.disposables) d.dispose();
  return null;
}

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("wat321");

  // --- Initial activation based on current settings ---
  if (config.get<boolean>("enableClaude", true)) {
    claudeGroup = activateClaude();
  }
  if (config.get<boolean>("enableCodex", true)) {
    codexGroup = activateCodex();
  }
  // Claude Force Auto-Compact is interactive tier - default OFF, requires claude group
  if (config.get<boolean>("enableClaudeForceAutoCompact", false)) {
    claudeForceAutoCompactGroup = activateClaudeForceAutoCompact(context);
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
          // If force-auto-compact was enabled before Claude, it couldn't
          // activate because it depends on claudeGroup. Now that Claude
          // is back, bring force-auto-compact up if its setting is still on.
          const claudeForceAutoCompactEnabled = vscode.workspace
            .getConfiguration("wat321")
            .get<boolean>("enableClaudeForceAutoCompact", false);
          if (claudeForceAutoCompactEnabled && !claudeForceAutoCompactGroup) {
            claudeForceAutoCompactGroup = activateClaudeForceAutoCompact(context);
          }
        } else if (!enabled && claudeGroup) {
          // Claude Force Auto-Compact depends on Claude - tear it down first
          claudeForceAutoCompactGroup = deactivateClaudeForceAutoCompact();
          claudeGroup = deactivateGroup(claudeGroup, "claude");
        }
      }

      if (e.affectsConfiguration("wat321.enableCodex")) {
        const enabled = vscode.workspace
          .getConfiguration("wat321")
          .get<boolean>("enableCodex", true);
        if (enabled && !codexGroup) {
          codexGroup = activateCodex();
        } else if (!enabled && codexGroup) {
          codexGroup = deactivateGroup(codexGroup, "codex");
        }
      }

      if (e.affectsConfiguration("wat321.enableClaudeForceAutoCompact")) {
        const enabled = vscode.workspace
          .getConfiguration("wat321")
          .get<boolean>("enableClaudeForceAutoCompact", false);
        if (enabled && !claudeForceAutoCompactGroup && claudeGroup) {
          claudeForceAutoCompactGroup = activateClaudeForceAutoCompact(context);
        } else if (!enabled && claudeForceAutoCompactGroup) {
          claudeForceAutoCompactGroup = deactivateClaudeForceAutoCompact();
        }
      }

      // Re-render all widgets immediately when display settings change
      if (e.affectsConfiguration("wat321.displayMode")) {
        rebroadcastAll();
      }
    })
  );

  // --- Command palette ---
  registerClearSettingsCommand(context);
  // Claude Force Auto-Compact command always registered so the palette entry has a
  // handler even when the feature is disabled. The handler itself shows
  // an info message pointing to the setting if the widget is not active.
  registerClaudeForceAutoCompactCommand(context, () => claudeForceAutoCompactGroup?.widget ?? null);
}

export function deactivate() {
  claudeForceAutoCompactGroup = deactivateClaudeForceAutoCompact();
  claudeGroup = deactivateGroup(claudeGroup, "claude");
  codexGroup = deactivateGroup(codexGroup, "codex");
}
