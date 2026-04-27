import * as vscode from "vscode";
import type { BridgeStageReader } from "./engine/bridgeTypes";
import type { ProviderGroup, ProviderKey, Subscribable } from "./engine/contracts";
import { setProviderActive } from "./engine/displayMode";
import type { EngineContext } from "./engine/engineContext";
import { bridgeSessionResponse } from "./engine/sessionResponseBridge";
import { SETTING } from "./engine/settingsKeys";
import { isNotificationsEnabled, subscribeToNotifications } from "./engine/toastNotifier";
import { ClaudeUsageSharedService } from "./shared/claude-usage/service";
import { CodexUsageSharedService } from "./shared/codex-usage/service";
import { readTail } from "./shared/fs/fileReaders";
import { classifyLastEntry } from "./shared/transcriptClassifier";
import { activateWidget } from "./shared/usageWidgetActivation";
import { parseLastAssistantText as parseCodexAssistantText } from "./shared/codex-rollout/assistantTextParser";
import { parseLastAssistantText as parseClaudeAssistantText } from "./WAT321_CLAUDE_SESSION_TOKENS/parsers";
import { ClaudeSessionTokenService } from "./WAT321_CLAUDE_SESSION_TOKENS/service";
import { ClaudeSessionTokensWidget } from "./WAT321_CLAUDE_SESSION_TOKENS/widget";
import { ClaudeUsage5hrWidget } from "./WAT321_CLAUDE_USAGE_5H/widget";
import { ClaudeUsageWeeklyWidget } from "./WAT321_CLAUDE_USAGE_WEEKLY/widget";
import { isCodexTurnComplete } from "./WAT321_CODEX_SESSION_TOKENS/parsers";
import { CodexSessionTokenService } from "./WAT321_CODEX_SESSION_TOKENS/service";
import { CodexSessionTokensWidget } from "./WAT321_CODEX_SESSION_TOKENS/widget";
import { CodexUsage5hrWidget } from "./WAT321_CODEX_USAGE_5H/widget";
import { CodexUsageWeeklyWidget } from "./WAT321_CODEX_USAGE_WEEKLY/widget";

/**
 * Provider registration and activation factories. Each provider
 * registers itself with the engine's ProviderRegistry via a
 * descriptor + activation function. The registry handles lifecycle;
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

/** Claude turn-completion classifier. Only `assistant-done` fires a
 * notification. The classifier deliberately distinguishes:
 *   - `assistant-pending` (tool_use in flight) - mid-turn, suppress
 *   - `compact-end` (auto-compact summary marker) - engine rotated
 *     context behind the scenes; the user's task isn't done, suppress
 *   - `interrupted` (user hit Esc / Ctrl+C) - user aborted, suppress
 *   - `unknown` (system / summary / unparseable) - suppress
 * so mid-turn writes, compaction events, and aborts do not all
 * masquerade as the same "Claude finished" notification. */
function isClaudeTurnComplete(tail: string): boolean {
  return classifyLastEntry(tail) === "assistant-done";
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
    ...activateWidget(usageService, new ClaudeUsage5hrWidget()),
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
    ...activateWidget(usageService, new CodexUsage5hrWidget()),
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
