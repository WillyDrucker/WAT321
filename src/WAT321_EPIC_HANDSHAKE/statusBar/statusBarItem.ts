import * as vscode from "vscode";
import type { EventHub } from "../../engine/eventHub";
import { getWidgetPriority, WIDGET_SLOT } from "../../engine/widgetCatalog";
import type { BridgeStageCoordinator } from "../bridgeStage/bridgeStageCoordinator";
import {
  createInitialRefreshState,
  onClaudeResponseComplete,
  refreshEpicHandshakeItem,
  type RefreshContext,
} from "./epicHandshakeStatusBarRefresh";
import type { InboxCoordinator } from "../../engine/inbox/inboxCoordinator";
import { isBridgeBusy } from "./statusBarState";
import { showMainMenu } from "./statusBarMenus";

/**
 * Epic Handshake status bar widget. Renders the bridge state between
 * the Claude and Codex session-token widgets as a three-icon layout:
 * `$(claude) [state] $(openai)`. Click opens the QuickPick menu
 * (retrieve, pause/resume, reset, delete, health). Animation frames
 * derive from wall-clock parity so no dedicated animation timer is
 * needed - the 1000ms tier refresh drives every transition.
 *
 * This file owns the VS Code item lifecycle (creation, command
 * registration, event subscription wiring, dispose). Render logic
 * lives in `epicHandshakeStatusBarRefresh.ts` - data sources live in
 * `epicHandshakeStatusBarSources.ts`. Wait mode setters are re-
 * exported here so callers outside this folder retain a single
 * import path.
 */

export { applyDefaultWaitMode, currentWaitMode } from "../codexTurn/waitMode";

const COMMAND_ID = "wat321.epicHandshake.manage";

export function createEpicHandshakeStatusBarItem(
  context: vscode.ExtensionContext,
  events: EventHub,
  bridgeStage: BridgeStageCoordinator,
  lateReplyInbox: InboxCoordinator
): {
  refresh: (opts: { enabled: boolean; workspacePath: string | null }) => void;
  dispose: () => void;
} {
  // Slot 5 in the widget catalog places the bridge between Claude
  // Session Tokens (slot 4) and Codex Session Tokens (slot 6) so the
  // icon visually separates the two providers.
  const item = vscode.window.createStatusBarItem(
    "wat321.epicHandshake",
    vscode.StatusBarAlignment.Right,
    getWidgetPriority(WIDGET_SLOT.epicHandshake)
  );
  item.name = "Epic Handshake";
  item.command = COMMAND_ID;
  item.hide();

  // Tooltip is intentionally never assigned. VS Code reshows the
  // hover overlay on every `item.tooltip` reassignment when hovering
  // (Issue #128887, open since 2021) and additionally re-fires the
  // overlay on window focus regain (Issue #293360, fix in PR #305676
  // not yet released). A tooltip that updates during a turn would
  // pop over toasts and reappear every alt-tab, overwhelming the
  // click-menu and toast workflow. All actionable bridge state lives
  // in the click-menu, so the tooltip carries no load-bearing info.
  // The hover falls back to `item.name` ("Epic Handshake") which is
  // a static label and never reshows.

  const register = vscode.commands.registerCommand(COMMAND_ID, async () => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    await showMainMenu({ inFlight: isBridgeBusy(ws) });
  });

  context.subscriptions.push(register, item);

  const ctx: RefreshContext = {
    item,
    bridgeStage,
    lateReplyInbox,
    state: createInitialRefreshState(),
  };

  // Mail-pulse subscription: a late reply arriving in inbox/claude/
  // grabs attention with an initial 5-second pulse. Each subsequent
  // completed Claude turn triggers another pulse, up to 3 total.
  // Rationale: the user keeps typing to Claude about unrelated
  // things - pulsing on each turn reminds them a Codex reply is
  // sitting in the bridge inbox. After 3 pulses OR 5 minutes from
  // arrival (whichever first), the widget returns to idle visually.
  // The envelope file stays until the dispatcher's 1-hour TTL sweep
  // or a prompt consumes it via collectLateReplies. A newer envelope
  // arriving resets the counter.
  const responseSub = events.on("session.responseComplete", (p) => {
    if (p.provider !== "claude") return;
    onClaudeResponseComplete(ctx.state, lateReplyInbox);
  });

  function refresh(opts: {
    enabled: boolean;
    workspacePath: string | null;
  }): void {
    refreshEpicHandshakeItem(ctx, opts);
  }

  return {
    refresh,
    dispose: () => {
      responseSub.dispose();
      item.dispose();
    },
  };
}
