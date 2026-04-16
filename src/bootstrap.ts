import * as vscode from "vscode";
import type { EngineContext } from "./engine/engineContext";
import type { ProviderGroup, ProviderKey, Subscribable } from "./engine/contracts";
import { SETTING } from "./engine/settingsKeys";
import { isNotificationsEnabled, subscribeToNotifications } from "./engine/toastNotifier";
import { readTail } from "./shared/fs/fileReaders";
import { ClaudeUsageSharedService } from "./shared/claude-usage/service";
import { CodexUsageSharedService } from "./shared/codex-usage/service";
import { setProviderActive } from "./shared/displayMode";
import { activateWidget } from "./shared/usageWidgetActivation";
import { classifyLastEntry, parseLastAssistantText as parseClaudeAssistantText } from "./WAT321_CLAUDE_SESSION_TOKENS/parsers";
import { ClaudeSessionTokenService } from "./WAT321_CLAUDE_SESSION_TOKENS/service";
import { ClaudeSessionTokensWidget } from "./WAT321_CLAUDE_SESSION_TOKENS/widget";
import { ClaudeUsage5hrWidget } from "./WAT321_CLAUDE_USAGE_5H/widget";
import { ClaudeUsageWeeklyWidget } from "./WAT321_CLAUDE_USAGE_WEEKLY/widget";
import { parseLastAssistantText as parseCodexAssistantText } from "./WAT321_CODEX_SESSION_TOKENS/parsers";
import { CodexSessionTokenService } from "./WAT321_CODEX_SESSION_TOKENS/service";
import { CodexSessionTokensWidget } from "./WAT321_CODEX_SESSION_TOKENS/widget";
import { CodexUsage5hrWidget } from "./WAT321_CODEX_USAGE_5H/widget";
import { CodexUsageWeeklyWidget } from "./WAT321_CODEX_USAGE_WEEKLY/widget";
import { ExperimentalAutoCompactService } from "./WAT321_EXPERIMENTAL_AUTOCOMPACT/service";

/**
 * Provider registration and activation factories. Each provider
 * registers itself with the engine's ProviderRegistry via a
 * descriptor + activation function. The registry handles lifecycle;
 * this file handles provider-specific wiring.
 */

/** Experimental auto-compact state, managed alongside the engine
 * but not a provider itself - it depends on Claude's token service. */
export interface ExperimentalAutoCompactGroup {
  disposables: vscode.Disposable[];
  service: ExperimentalAutoCompactService;
}

let experimentalAutoCompact: ExperimentalAutoCompactGroup | null = null;

function workspacePath(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
}

/** Watch a usage service's connectivity state and update the
 * display-mode provider-active flag when it transitions between
 * connected and not-connected. Triggers a rebroadcast on every
 * connectivity transition so display mode and brand colors pick
 * up the change immediately.
 *
 * The distinction matters: a provider whose group is activated but
 * whose CLI is not installed reports `not-connected`. That provider
 * must NOT count as active for Auto display mode resolution or
 * dual-provider brand-color logic. This watcher handles organic
 * transitions (CLI installed/uninstalled mid-session). Settings-
 * driven deactivation is handled by extension.ts calling
 * `setProviderActive(key, false)` directly since dispose runs
 * before the watcher can detect the transition. */
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

/** Watch a session token service for context-usage changes and
 * emit `session.responseComplete` on the EventHub. The bridge
 * owns turn-completion gating and response preview parsing -
 * services stay notification-unaware. Reads the transcript tail
 * on every contextUsed change (for turn-completion classification)
 * and parses the response preview only when notifications are
 * enabled. */
// Narrow types for the session response bridge. Defined here
// rather than in contracts.ts because they're specific to the
// notification wiring - services don't need to know about them.
interface SessionResponseFields {
  contextUsed: number;
  label: string;
  sessionTitle: string;
}

type SessionResponseState =
  | { status: "ok"; session: SessionResponseFields }
  | { status: string };

interface SessionResponseSource {
  subscribe(listener: (state: SessionResponseState) => void): void;
  unsubscribe(listener: (state: SessionResponseState) => void): void;
  getActiveTranscriptPath(): string | null;
}

/** Claude turn-completion classifier for the notification bridge.
 * Returns true only when the last transcript entry is a final
 * assistant message (text-only, no pending tool_use blocks). Suppresses
 * mid-tool-call notifications that would otherwise spam the user on
 * every contextUsed change during a multi-step response. */
function isClaudeTurnComplete(tail: string): boolean {
  const kind = classifyLastEntry(tail);
  return kind === "assistant-done" || kind === "unknown";
}

function watchSessionResponse(
  key: ProviderKey,
  tokenService: SessionResponseSource,
  parseAssistantText: (tail: string) => string,
  isTurnComplete: ((tail: string) => boolean) | null,
  ctx: EngineContext
): vscode.Disposable {
  let prevContextUsed = -1;
  const listener = (state: SessionResponseState) => {
    if (state.status !== "ok") return;
    const session = (state as { status: "ok"; session: SessionResponseFields }).session;
    if (session.contextUsed === prevContextUsed) return;
    const isFirstRead = prevContextUsed === -1;
    prevContextUsed = session.contextUsed;
    // Skip the initial state delivery - only fire on actual changes.
    if (isFirstRead) return;

    // Read the transcript tail for both turn-completion gating and
    // response preview extraction.
    const path = tokenService.getActiveTranscriptPath();
    const tail = path ? readTail(path) : null;

    // Suppress mid-turn notifications. During a multi-tool-call
    // response, contextUsed changes on every tool call and tool
    // result. Only fire when the turn is actually complete (the
    // last transcript entry is a final assistant message with no
    // pending tool_use blocks). If the tail is unreadable or no
    // classifier is provided, bias toward firing.
    if (isTurnComplete && tail && !isTurnComplete(tail)) return;

    let responsePreview = "";
    if (isNotificationsEnabled() && tail) {
      responsePreview = parseAssistantText(tail);
    }

    ctx.events.emit("session.responseComplete", {
      provider: key,
      displayName: ctx.providers.getDescriptor(key)?.displayName ?? key,
      label: session.label,
      sessionTitle: session.sessionTitle,
      responsePreview,
    });
  };
  tokenService.subscribe(listener);
  return { dispose: () => tokenService.unsubscribe(listener) };
}

/** Register both providers with the engine and subscribe
 * engine-level event consumers. Call once from extension.ts
 * activate(). Returns disposables for the extension context. */
export function registerProviders(ctx: EngineContext): vscode.Disposable[] {
  ctx.providers.register(
    { key: "claude", displayName: "Claude", settingKey: SETTING.enableClaude },
    () => buildClaudeGroup(ctx)
  );
  ctx.providers.register(
    { key: "codex", displayName: "Codex", settingKey: SETTING.enableCodex },
    () => buildCodexGroup(ctx)
  );

  return [
    subscribeToNotifications(ctx.events),
  ];
}

function buildClaudeGroup(ctx: EngineContext): ProviderGroup {
  const usageService = new ClaudeUsageSharedService();
  const tokenService = new ClaudeSessionTokenService(workspacePath());

  usageService.setActivityProbe(() => tokenService.getLastActivityMs());

  const disposables: vscode.Disposable[] = [
    ...activateWidget(usageService, new ClaudeUsage5hrWidget()),
    ...activateWidget(usageService, new ClaudeUsageWeeklyWidget()),
    ...activateWidget(tokenService, new ClaudeSessionTokensWidget()),
    watchProviderAvailability("claude", usageService, ctx),
    watchSessionResponse("claude", tokenService, parseClaudeAssistantText, isClaudeTurnComplete, ctx),
    { dispose: () => usageService.dispose() },
    { dispose: () => tokenService.dispose() },
  ];

  usageService.start();
  tokenService.start();

  return { disposables, usageService, tokenService };
}

function buildCodexGroup(ctx: EngineContext): ProviderGroup {
  const usageService = new CodexUsageSharedService();
  const tokenService = new CodexSessionTokenService(workspacePath());

  usageService.setActivityProbe(() => tokenService.getLastActivityMs());

  const disposables: vscode.Disposable[] = [
    ...activateWidget(usageService, new CodexUsage5hrWidget()),
    ...activateWidget(usageService, new CodexUsageWeeklyWidget()),
    ...activateWidget(tokenService, new CodexSessionTokensWidget()),
    watchProviderAvailability("codex", usageService, ctx),
    watchSessionResponse("codex", tokenService, parseCodexAssistantText, null, ctx),
    { dispose: () => usageService.dispose() },
    { dispose: () => tokenService.dispose() },
  ];

  usageService.start();
  tokenService.start();

  return { disposables, usageService, tokenService };
}

/** Activate experimental auto-compact if Claude is active. */
export function activateExperimentalAutoCompact(
  ctx: EngineContext
): ExperimentalAutoCompactGroup | null {
  const claude = ctx.providers.getGroup("claude");
  if (!claude) return null;
  const service = new ExperimentalAutoCompactService(
    claude.tokenService as ClaudeSessionTokenService
  );
  service.start();
  experimentalAutoCompact = {
    disposables: [{ dispose: () => service.dispose() }],
    service,
  };
  return experimentalAutoCompact;
}

/** Deactivate experimental auto-compact. */
export function deactivateExperimentalAutoCompact(): void {
  if (!experimentalAutoCompact) return;
  for (const d of experimentalAutoCompact.disposables) d.dispose();
  experimentalAutoCompact = null;
}

/** Get the active experimental auto-compact service, if any. */
export function getExperimentalAutoCompactService(): ExperimentalAutoCompactService | null {
  return experimentalAutoCompact?.service ?? null;
}
