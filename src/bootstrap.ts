import * as vscode from "vscode";
import type { BridgeStageReader } from "./engine/bridgeTypes";
import type { ProviderGroup, ProviderKey, Subscribable } from "./engine/contracts";
import { setProviderActive } from "./engine/displayMode";
import type { EngineContext } from "./engine/engineContext";
import { bridgeSessionResponse } from "./engine/sessionResponseBridge";
import { SETTING } from "./engine/settingsKeys";
import { isNotificationsEnabled, subscribeToNotifications } from "./engine/toastNotifier";
import { ClaudeUsageSharedService } from "./shared/claudeUsage/claudeUsageService";
import { CodexUsageSharedService } from "./shared/codexUsage/codexUsageService";
import { readTail } from "./engine/fs/fileReaders";
import { activateWidget } from "./shared/usageWidgetActivation";
import { parseLastAssistantText as parseCodexAssistantText } from "./shared/codexRollout/assistantTextParser";
import { parseLastAssistantText as parseClaudeAssistantText } from "./WAT321_CLAUDE_SESSION_TOKENS/transcriptParsers";
import { ClaudeSessionTokenService } from "./WAT321_CLAUDE_SESSION_TOKENS/claudeSessionTokenService";
import { isClaudeTurnComplete } from "./WAT321_CLAUDE_SESSION_TOKENS/claudeTurnClassifier";
import { ClaudeSessionTokensWidget } from "./WAT321_CLAUDE_SESSION_TOKENS/claudeSessionTokensWidget";
import { ClaudeUsageErrorWidget } from "./WAT321_CLAUDE_USAGE_ERROR/claudeUsageErrorWidget";
import { ClaudeUsage5hWidget } from "./WAT321_CLAUDE_USAGE_5H/claudeUsage5hWidget";
import { ClaudeUsageWeeklyWidget } from "./WAT321_CLAUDE_USAGE_WEEKLY/claudeUsageWeeklyWidget";
import { isCodexTurnComplete } from "./WAT321_CODEX_SESSION_TOKENS/codexTurnClassifier";
import { CodexSessionTokenService } from "./WAT321_CODEX_SESSION_TOKENS/codexSessionTokenService";
import { CodexSessionTokensWidget } from "./WAT321_CODEX_SESSION_TOKENS/codexSessionTokensWidget";
import { CodexUsageErrorWidget } from "./WAT321_CODEX_USAGE_ERROR/codexUsageErrorWidget";
import { CodexUsage5hWidget } from "./WAT321_CODEX_USAGE_5H/codexUsage5hWidget";
import { CodexUsageWeeklyWidget } from "./WAT321_CODEX_USAGE_WEEKLY/codexUsageWeeklyWidget";

/**
 * Provider registration and activation factories. Each provider
 * registers itself with the engine's ProviderRegistry via a
 * descriptor + activation function. The registry handles lifecycle -
 * this file handles provider-specific wiring.
 */

function getWorkspacePath(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
}

/** Bridge usage-service connectivity to the display-mode flag.
 *
 * The distinction between lifecycle and connectivity matters: a
 * provider whose group is activated but whose CLI is not installed
 * reports `not-connected`. That provider must NOT count as active
 * for Auto display mode resolution or dual-provider brand-color
 * logic. This watcher handles organic transitions (CLI installed /
 * uninstalled mid-session). Settings-driven deactivation is handled
 * by extension.ts calling `setProviderActive(key, false)` directly
 * because dispose runs before the watcher can detect it. */
function watchProviderAvailability(
  key: ProviderKey,
  usageService: Pick<Subscribable<{ status: string }>, "subscribe" | "unsubscribe">,
  ctx: EngineContext
): vscode.Disposable {
  let wasConnected = false;
  const listener = (state: { status: string }) => {
    const nowConnected = state.status !== "not-connected";
    if (nowConnected === wasConnected) return;
    wasConnected = nowConnected;
    setProviderActive(key, nowConnected);
    ctx.events.emit(
      nowConnected ? "provider.connected" : "provider.disconnected",
      { provider: key }
    );
    ctx.providers.rebroadcastAll();
  };
  usageService.subscribe(listener);
  return { dispose: () => usageService.unsubscribe(listener) };
}

/** Register both providers with the engine and subscribe engine-level
 * event consumers. Call once from extension.ts activate(). The
 * `bridgeStage` reader comes from the EH tier (which activates first
 * in extension.ts) and feeds the session-token widgets so they can
 * render the bridge ceremony / stage glyph cycle without polling
 * heartbeat files directly. */
export function registerProviders(
  ctx: EngineContext,
  bridgeStage: BridgeStageReader
): vscode.Disposable[] {
  ctx.providers.register(
    { key: "claude", displayName: "Claude", settingKey: SETTING.enableClaude },
    () => buildClaudeGroup(ctx, bridgeStage)
  );
  ctx.providers.register(
    { key: "codex", displayName: "Codex", settingKey: SETTING.enableCodex },
    () => buildCodexGroup(ctx, bridgeStage)
  );

  return [
    subscribeToNotifications(ctx.events),
  ];
}

function buildClaudeGroup(
  ctx: EngineContext,
  bridgeStage: BridgeStageReader
): ProviderGroup {
  const usageService = new ClaudeUsageSharedService();
  const tokenService = new ClaudeSessionTokenService(getWorkspacePath());

  usageService.setActivityProbe(() => tokenService.getLastActivityMs());

  const disposables: vscode.Disposable[] = [
    ...activateWidget(usageService, new ClaudeUsage5hWidget()),
    ...activateWidget(usageService, new ClaudeUsageErrorWidget()),
    ...activateWidget(usageService, new ClaudeUsageWeeklyWidget()),
    ...activateWidget(tokenService, new ClaudeSessionTokensWidget(bridgeStage)),
    watchProviderAvailability("claude", usageService, ctx),
    bridgeSessionResponse({
      provider: "claude",
      displayName: ctx.providers.getDescriptor("claude")?.displayName ?? "Claude",
      tokenService,
      readTail,
      parseAssistantText: parseClaudeAssistantText,
      isTurnComplete: isClaudeTurnComplete,
      shouldParsePreview: isNotificationsEnabled,
      events: ctx.events,
    }),
    { dispose: () => usageService.dispose() },
    { dispose: () => tokenService.dispose() },
  ];

  usageService.start();
  tokenService.start();

  return { disposables, usageService, tokenService };
}

function buildCodexGroup(
  ctx: EngineContext,
  bridgeStage: BridgeStageReader
): ProviderGroup {
  const usageService = new CodexUsageSharedService();
  const tokenService = new CodexSessionTokenService(getWorkspacePath());

  usageService.setActivityProbe(() => tokenService.getLastActivityMs());

  const disposables: vscode.Disposable[] = [
    ...activateWidget(usageService, new CodexUsage5hWidget()),
    ...activateWidget(usageService, new CodexUsageErrorWidget()),
    ...activateWidget(usageService, new CodexUsageWeeklyWidget()),
    ...activateWidget(tokenService, new CodexSessionTokensWidget(bridgeStage)),
    watchProviderAvailability("codex", usageService, ctx),
    bridgeSessionResponse({
      provider: "codex",
      displayName: ctx.providers.getDescriptor("codex")?.displayName ?? "Codex",
      tokenService,
      readTail,
      parseAssistantText: parseCodexAssistantText,
      isTurnComplete: isCodexTurnComplete,
      shouldParsePreview: isNotificationsEnabled,
      events: ctx.events,
    }),
    { dispose: () => usageService.dispose() },
    { dispose: () => tokenService.dispose() },
  ];

  usageService.start();
  tokenService.start();

  return { disposables, usageService, tokenService };
}
