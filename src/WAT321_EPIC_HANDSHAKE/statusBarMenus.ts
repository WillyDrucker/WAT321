import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import * as vscode from "vscode";
import {
  CODEX_FULL_ACCESS_FLAG_PATH,
  waitModeFlashFlagPath,
} from "./constants";
import { listLateReplies } from "./lateReplyInbox";
import {
  makeCancelItem,
  makePauseResumeItem,
  withMenuLifecycle,
  type Action,
  type ActionContext,
  type Item,
} from "./menuCommon";
import {
  discardAllLateReplies,
  showLateRepliesPicker,
  showRecoverSessionPicker,
  showSessionsSubmenu,
} from "./menuPickers";
import {
  currentWorkspacePath,
  isBridgeBusy,
  isPaused,
  setPaused,
} from "./statusBarState";
import {
  clearBridgeErrorState,
  listRecoverableSessions,
  loadBridgeThreadRecord,
} from "./threadPersistence";
import { writeCancelFlag } from "./turnFlags";
import {
  readNewestHeartbeat,
  renderStageTooltipBlock,
} from "./turnHeartbeat";
import {
  applyWaitMode,
  currentWaitMode,
  nextWaitMode,
  waitModeDetail,
  waitModeLabel,
} from "./waitMode";
import { workspaceHash } from "./workspaceHash";

/**
 * Main QuickPick entry point + dispatch surface for the Epic Handshake
 * widget. The status bar item registers a command that calls
 * `showMainMenu`; sub-pickers in `menuPickers.ts` route back through
 * `handleAction` via the dispatch callback so every action has exactly
 * one switch.
 *
 * Item factories and lifecycle plumbing live in `menuCommon.ts`.
 */

export { setMenuLifecycleHooks } from "./menuCommon";

export async function showMainMenu(opts: { inFlight: boolean }): Promise<void> {
  const paused = isPaused();
  const ws = currentWorkspacePath();
  const lateReplies = ws ? listLateReplies(ws) : [];
  const lateCount = lateReplies.length;
  const currentRecord = ws ? loadBridgeThreadRecord(ws) : null;
  const hasError = (currentRecord?.consecutiveFailures ?? 0) > 0;
  const sessionCounter = currentRecord?.sessionCounter ?? 1;

  const pauseItem = makePauseResumeItem(paused, opts.inFlight);
  const cancelItem = makeCancelItem(opts.inFlight);

  // Bridge status info - placed first so VS Code's QuickPick
  // auto-focus lands here and its `detail` renders expanded on menu
  // open. This is the click-to-see replacement for the old
  // hover-tooltip stage block (stripped to eliminate VS Code's
  // reassignment-reshow bug over toasts).
  const wsHash = ws ? workspaceHash(ws) : null;
  const hb = wsHash ? readNewestHeartbeat(wsHash) : null;
  const statusDetail = hb
    ? renderStageTooltipBlock(hb, Date.now())
    : paused
      ? "Bridge paused. Resume via the menu below."
      : opts.inFlight
        ? "Turn starting. Details populate on the next heartbeat."
        : "Bridge idle. Send a Claude to Codex prompt to start a turn.";
  const statusItem: Item = {
    label: "Bridge status",
    description: hb
      ? `Stage ${hb.stage}`
      : paused
        ? "(paused)"
        : opts.inFlight
          ? "(turn starting...)"
          : "(idle)",
    detail: statusDetail,
    iconPath: new vscode.ThemeIcon("info"),
    action: "show-status",
  };

  // Retrieve always visible. At zero it's informational (friendly
  // toast on click); at >= 1 it opens the late-replies picker.
  const retrieveItem: Item = {
    label: `Retrieve late replies (${lateCount})`,
    description:
      lateCount === 0
        ? "No pending replies right now."
        : "Codex replies that arrived after a prompt timed out.",
    detail:
      lateCount === 0
        ? "When Codex replies to a timed-out prompt, you can read it here."
        : "Pick one to copy to clipboard.",
    iconPath: new vscode.ThemeIcon("wat321-square-mail"),
    action: "retrieve",
  };

  const current = currentWaitMode();
  const next = nextWaitMode(current);
  const waitModeItem: Item | null = paused
    ? null
    : {
        label: `Wait mode: ${waitModeLabel(current)}`,
        description: `Click to switch to ${waitModeLabel(next)}.`,
        detail: waitModeDetail(current),
        iconPath: new vscode.ThemeIcon("wat321-square-bolt"),
        action: "wait-mode-toggle",
      };

  const sessionsItem: Item = {
    label: `Manage Codex Sessions (S${sessionCounter})`,
    description: "Reset, delete, or recover.",
    detail: "Opens a submenu for Codex session controls.",
    iconPath: new vscode.ThemeIcon("wat321-square-arrow-right"),
    action: "manage-sessions",
  };

  const clearErrorItem: Item | null =
    hasError && !paused
      ? {
          label: "Clear error state",
          description: "Dismiss the red icon without rotating thread.",
          detail: currentRecord?.lastError
            ? `Last error: ${currentRecord.lastError.slice(0, 120)}`
            : "Resets the failure counter. If next prompt also fails, pick Reset from Manage Codex Sessions.",
          iconPath: new vscode.ThemeIcon("wat321-square-check"),
          action: "clear-error",
        }
      : null;

  // Menu ordering rules (applied across every picker):
  //   1. Status info at the very top. VS Code auto-focuses the first
  //      item and expands its `detail` - that's how the user reads
  //      the stage block without a hover tooltip. Icon is neutral
  //      `info` so the focus-highlight overlay doesn't cover any
  //      colored tint.
  //   2. Retrieve next - always visible, still above colored icons.
  //   3. Pause and Cancel paired at the bottom of every menu -
  //      Pause right above Cancel - predictable across main + submenus.
  //   4. Everything else (wait mode, sessions, clear-error) goes in
  //      between.
  const items: Item[] = [
    statusItem,
    retrieveItem,
    ...(waitModeItem ? [waitModeItem] : []),
    sessionsItem,
    ...(clearErrorItem ? [clearErrorItem] : []),
    ...(pauseItem ? [pauseItem] : []),
    ...(cancelItem ? [cancelItem] : []),
  ];

  const pick = await withMenuLifecycle(() =>
    vscode.window.showQuickPick(items, {
      title: `WAT321 Epic Handshake${paused ? " (paused)" : ""}`,
      placeHolder: "Choose an action",
    })
  );
  if (!pick) return;

  await handleAction(pick.action, {
    ws,
    lateReplies,
    recoverable: ws ? listRecoverableSessions(ws) : [],
    inFlight: opts.inFlight,
  });
}

/** Single dispatch point for every action any menu can produce.
 * Sub-menus pass this in as their `dispatch` callback so they can
 * route Pause/Resume/Cancel/Back through the same switch. */
async function handleAction(action: Action, ctx: ActionContext): Promise<void> {
  switch (action) {
    case "pause":
      setPaused(true);
      break;
    case "resume":
      setPaused(false);
      break;
    case "reset":
      await vscode.commands.executeCommand(
        "wat321.epicHandshake.resetCodexSession"
      );
      break;
    case "delete":
      await vscode.commands.executeCommand(
        "wat321.epicHandshake.deleteCodexSession"
      );
      break;
    case "delete-all":
      await vscode.commands.executeCommand(
        "wat321.epicHandshake.deleteAllCodexSessions"
      );
      break;
    case "retrieve":
      if (ctx.lateReplies.length === 0) {
        void vscode.window.showInformationMessage(
          "Epic Handshake: inbox is empty. New replies will surface here as they arrive."
        );
      } else {
        await showLateRepliesPicker(ctx.lateReplies, ctx.inFlight, handleAction);
      }
      break;
    case "discard-mail":
      await discardAllLateReplies(ctx.lateReplies);
      break;
    case "recover":
      if (ctx.ws) {
        await showRecoverSessionPicker(
          ctx.ws,
          ctx.recoverable,
          ctx.inFlight,
          handleAction
        );
      }
      break;
    case "clear-error":
      if (ctx.ws) {
        clearBridgeErrorState(ctx.ws);
        void vscode.window.showInformationMessage(
          "Epic Handshake: error state cleared. Widget returns to idle."
        );
      }
      break;
    case "cancel":
      if (!ctx.ws) {
        void vscode.window.showWarningMessage(
          "Epic Handshake: no workspace open; cancel flag cannot be scoped."
        );
        return;
      }
      // Re-check at action time: the menu item is now always visible
      // (so the user can always find it), but if they click it outside
      // of an active turn we just toast "nothing to cancel" and skip
      // the flag write. Writing the flag with no active runTurnOnce
      // to consume it would leave a stale cancel sentinel that would
      // instantly interrupt the NEXT turn.
      if (!isBridgeBusy(ctx.ws)) {
        void vscode.window.showInformationMessage(
          "Epic Handshake: no turn to cancel right now."
        );
        return;
      }
      writeCancelFlag(ctx.ws);
      void vscode.window.showInformationMessage(
        "Epic Handshake: sent interrupt to Codex. Claude receives a \"cancelled by user\" reply within ~1s."
      );
      break;
    case "permissions-toggle": {
      // Toggle the Codex full-access sentinel flag. New value takes
      // effect on the NEXT thread spawn (reset / delete / fresh
      // after rotate); existing thread keeps its current sandbox
      // because Codex's app-server doesn't allow mid-session change.
      // Toast tells the user explicitly so they can decide whether
      // to reset right away.
      const isFullAccessNow = existsSync(CODEX_FULL_ACCESS_FLAG_PATH);
      try {
        if (isFullAccessNow) {
          unlinkSync(CODEX_FULL_ACCESS_FLAG_PATH);
          void vscode.window.showInformationMessage(
            "Epic Handshake: Codex permissions set to Read-Only. Reset the session for the change to take effect."
          );
        } else {
          writeFileSync(
            CODEX_FULL_ACCESS_FLAG_PATH,
            new Date().toISOString(),
            "utf8"
          );
          void vscode.window.showWarningMessage(
            "Epic Handshake: Codex permissions set to Full-Access. Reset the session for the change to take effect. Codex now has full filesystem and shell access."
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(
          `Epic Handshake: could not toggle Codex permissions: ${msg}`
        );
      }
      break;
    }
    case "wait-mode-toggle": {
      // Three-way cycle: Standard -> Adaptive -> Fire-and-Forget ->
      // Standard. No toast; the 2500ms bolt-square flash on the
      // status bar is the visual confirmation regardless of which
      // direction the cycle advanced. Flash flag is workspace-scoped
      // so only THIS window flashes; sibling windows ignore.
      applyWaitMode(nextWaitMode(currentWaitMode()));
      if (ctx.ws) {
        try {
          writeFileSync(
            waitModeFlashFlagPath(workspaceHash(ctx.ws)),
            new Date().toISOString(),
            "utf8"
          );
        } catch {
          // best-effort
        }
      }
      break;
    }
    case "show-status":
      // Info-only item: the status block renders in the item's
      // `detail` field which is already visible when the menu is
      // open (VS Code auto-focuses the first item). Clicking it
      // closes the menu - nothing else to do. The block updates
      // every time the menu opens because this switch rebuilds it.
      return;
    case "manage-sessions":
      await showSessionsSubmenu({
        ws: ctx.ws,
        inFlight: ctx.inFlight,
        recoverable: ctx.recoverable,
        dispatch: handleAction,
      });
      break;
    case "back":
      // Sub-menus invoke this to return to the main menu so the user
      // doesn't have to close + re-click the status bar widget. We
      // re-read inFlight from the flag files so the menu reflects
      // current state, not stale state from when the sub-menu opened.
      await showMainMenu({ inFlight: isBridgeBusy(ctx.ws) });
      break;
  }
}

// Re-exports preserved for callers that imported through this module
// before the menuCommon/menuPickers split.
export { bridgeThreadDisplayName } from "./threadPersistence";
export { countPendingLateReplies } from "./lateReplyInbox";
