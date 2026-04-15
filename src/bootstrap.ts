import * as vscode from "vscode";
import { ClaudeUsageSharedService } from "./shared/claude-usage/service";
import { CodexUsageSharedService } from "./shared/codex-usage/service";
import { providerState } from "./shared/displayMode";
import { activateUsageWidget } from "./shared/usageWidgetActivation";
import { ClaudeSessionTokenService } from "./WAT321_CLAUDE_SESSION_TOKENS/service";
import { activateClaudeTokenWidget } from "./WAT321_CLAUDE_SESSION_TOKENS/widget";
import { ClaudeUsage5hrWidget } from "./WAT321_CLAUDE_USAGE_5H/widget";
import { ClaudeUsageWeeklyWidget } from "./WAT321_CLAUDE_USAGE_WEEKLY/widget";
import { CodexSessionTokenService } from "./WAT321_CODEX_SESSION_TOKENS/service";
import { activateCodexTokenWidget } from "./WAT321_CODEX_SESSION_TOKENS/widget";
import { CodexUsage5hrWidget } from "./WAT321_CODEX_USAGE_5H/widget";
import { CodexUsageWeeklyWidget } from "./WAT321_CODEX_USAGE_WEEKLY/widget";
import { ExperimentalAutoCompactService } from "./WAT321_EXPERIMENTAL_AUTOCOMPACT/service";

/**
 * Provider activation and teardown. Kept out of `extension.ts` so the
 * top-level entry can stay focused on the VS Code command/config
 * wiring while this file owns the "what gets wired up when a provider
 * is enabled" decisions.
 */

interface ProviderService {
  dispose(): void;
  rebroadcast(): void;
  setActivityProbe(probe: () => number | null): void;
  resetKickstartEscalation(): void;
  subscribe(listener: (state: { status: string }) => void): void;
  unsubscribe(listener: (state: { status: string }) => void): void;
}

/** Base shape shared by both provider groups. The token service is
 * left generic here so each concrete subtype can narrow it to the
 * provider's actual class, avoiding the `as unknown as` double cast
 * that the experimental-tier activator otherwise needs. */
export interface ProviderGroup<
  TTokenService extends { dispose(): void; rebroadcast(): void } = {
    dispose(): void;
    rebroadcast(): void;
  }
> {
  disposables: vscode.Disposable[];
  usageService: ProviderService;
  tokenService: TTokenService;
}

export type ClaudeProviderGroup = ProviderGroup<ClaudeSessionTokenService>;
export type CodexProviderGroup = ProviderGroup<CodexSessionTokenService>;

export interface ExperimentalAutoCompactGroup {
  disposables: vscode.Disposable[];
  service: ExperimentalAutoCompactService;
}

export interface ActiveGroups {
  claude: ClaudeProviderGroup | null;
  codex: CodexProviderGroup | null;
  experimentalAutoCompact: ExperimentalAutoCompactGroup | null;
}

function workspacePath(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
}

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

export function activateClaude(groups: ActiveGroups): ClaudeProviderGroup {
  const usageService = new ClaudeUsageSharedService();
  const tokenService = new ClaudeSessionTokenService(workspacePath());

  // Activity-driven kickstart: the usage service polls this on every
  // refresh, and a fresh transcript mtime trips a wake out of the
  // rate-limited park. Live activity is ground-truth evidence Anthropic
  // is serving the user right now, so any lockout we are sitting on is
  // stale by definition.
  usageService.setActivityProbe(() => tokenService.getLastActivityMs());

  const disposables: vscode.Disposable[] = [
    ...activateUsageWidget(usageService, new ClaudeUsage5hrWidget()),
    ...activateUsageWidget(usageService, new ClaudeUsageWeeklyWidget()),
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

export function activateCodex(groups: ActiveGroups): CodexProviderGroup {
  const codexService = new CodexUsageSharedService();
  const tokenService = new CodexSessionTokenService(workspacePath());

  codexService.setActivityProbe(() => tokenService.getLastActivityMs());

  const disposables: vscode.Disposable[] = [
    ...activateUsageWidget(codexService, new CodexUsage5hrWidget()),
    ...activateUsageWidget(codexService, new CodexUsageWeeklyWidget()),
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

/** Activate the experimental Force Claude Auto-Compact service. The
 * service subscribes to the configuration change event directly - no
 * widget, no command registration, no consent prompt. Requires the
 * Claude group to be active because the service needs
 * `ClaudeSessionTokenService.getActiveTranscriptPath()` to know which
 * transcript to watch for the compact marker. */
export function activateExperimentalAutoCompact(
  groups: ActiveGroups
): ExperimentalAutoCompactGroup | null {
  if (!groups.claude) return null;
  const service = new ExperimentalAutoCompactService(
    groups.claude.tokenService
  );
  service.start();
  return {
    disposables: [{ dispose: () => service.dispose() }],
    service,
  };
}

export function deactivateExperimentalAutoCompact(
  group: ExperimentalAutoCompactGroup | null
): null {
  if (!group) return null;
  for (const d of group.disposables) d.dispose();
  return null;
}
