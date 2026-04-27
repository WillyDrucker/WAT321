import { writeFileAtomic } from "../shared/fs/atomicWrite";
import * as vscode from "vscode";
import { waitModeFlashFlagPath } from "./constants";
import { listLateReplies } from "./lateReplyInbox";
import {
  makeCancelItem,
  makePauseResumeItem,
  withMenuLifecycle,
  type Action,
  type ActionContext,
  type Item,
} from "./menuCommon";
import { showCodexDefaultsPicker } from "./codexDefaultsPicker";
import {
  discardAllLateReplies,
  showLateRepliesPicker,
} from "./lateReplyPickers";
import {
  showRecoverSessionPicker,
  showRepairSessionsPicker,
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
  applyWaitMode,
  currentWaitMode,
  nextWaitMode,
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

  // Retrieve always visible. At zero it's informational (friendly
  // toast on click); at >= 1 it opens the late-replies picker which
  // copies each reply to clipboard and clears it from the inbox.
  const retrieveItem: Item = {
    label: `RETRIEVE LATE REPLIES (${lateCount})`,
    description:
      lateCount === 0
        ? "No pending replies right now."
        : "Copies to clipboard and clears the inbox.",
    iconPath: new vscode.ThemeIcon("mail"),
    action: "retrieve",
  };

  const current = currentWaitMode();
  const next = nextWaitMode(current);
  // Wait mode locks while a turn is in flight. Switching mid-turn
  // would let the in-flight envelope's dispatcher flags go out of
  // sync with the newly-selected mode (Adaptive -> Fire-and-Forget
  // mid-turn leaves the blocking MCP call waiting forever, the
  // reverse direction leaves a fire-and-forget reply stranded). The
  // row stays visible showing the current mode so the user can see
  // it but cannot flip it; action-handler guard enforces the lock
  // even if the click lands between build and handle.
  const waitModeItem: Item | null = paused
    ? null
    : opts.inFlight
      ? {
          label: `WAIT MODE: ${waitModeLabel(current)}`,
          description: "Locked while a bridge turn is running.",
          iconPath: new vscode.ThemeIcon("wat321-square-bolt"),
          action: "wait-mode-locked",
        }
      : {
          label: `WAIT MODE: ${waitModeLabel(current)}`,
          description: `Click to switch to ${waitModeLabel(next)}.`,
          iconPath: new vscode.ThemeIcon("wat321-square-bolt"),
          action: "wait-mode-toggle",
        };

  const sessionsItem: Item = {
    label: `MANAGE CODEX SESSIONS (S${sessionCounter})`,
    description: "Reset, delete, recover, or change defaults.",
    iconPath: new vscode.ThemeIcon("wat321-square-info"),
    action: "manage-sessions",
  };

  const clearErrorItem: Item | null =
    hasError && !paused
      ? {
          label: "CLEAR",
          description: "Clears bridge errors, only if there's something to clear.",
          detail: currentRecord?.lastError
            ? `Last error: ${currentRecord.lastError.slice(0, 120)}`
            : undefined,
          iconPath: new vscode.ThemeIcon("wat321-square-check"),
          action: "clear-error",
        }
      : null;

  // Backup safety net for the rare case where Codex's app-server has
  // cached stale config or otherwise needs a hard reset. Bundles
  // cancel + clear + force-kill so the user has one click instead of
  // three. Resumes the active S<n> bridge thread on the next prompt;
  // does NOT touch the Codex VS Code extension itself (that would
  // require a full window reload, which we cannot avoid - and which
  // would force a Claude cache LOAD). Always visible because the
  // value is exactly that it works when nothing else does.
  const restartBridgeItem: Item = {
    label: "RESTART CODEX BRIDGE",
    description: `Cancel, clear and restart bridge. Resumes (S${sessionCounter}) on next prompt.`,
    iconPath: new vscode.ThemeIcon("sync"),
    action: "restart-bridge",
  };

  // Menu ordering: retrieve up top, sessions immediately below it
  // (most-frequent action grouping), wait-mode toggle, conditional
  // clear, restart-bridge as the heavier escalation right above
  // pause, then pause and cancel always at the bottom. Pause and
  // cancel are visible in every menu (including submenus) for
  // consistent escape paths regardless of where the user navigated.
  const items: Item[] = [
    retrieveItem,
    sessionsItem,
    ...(waitModeItem ? [waitModeItem] : []),
    ...(clearErrorItem ? [clearErrorItem] : []),
    restartBridgeItem,
    pauseItem,
    cancelItem,
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
    case "codex-defaults":
      // Codex Defaults picker: combined sandbox + model + effort
      // entry point. All three are per-turn overrides, so the change
      // takes effect on the next prompt without a thread reset. The
      // picker is locked while a bridge turn is running because the
      // override flags it writes are read mid-turn; switching while
      // a turn is outstanding would mean the in-flight envelope used
      // one set of values while the user expected another.
      if (isBridgeBusy(ctx.ws)) {
        void vscode.window.showInformationMessage(
          "Epic Handshake: Codex Defaults are locked while a bridge turn is running. They will unlock automatically when the turn finishes."
        );
        break;
      }
      await showCodexDefaultsPicker(handleAction, {
        ws: ctx.ws,
        lateReplies: [],
        recoverable: ctx.recoverable,
        inFlight: ctx.inFlight,
      });
      break;
    case "wait-mode-toggle": {
      // Three-way cycle: Standard -> Adaptive -> Fire-and-Forget ->
      // Standard. No toast; the 2500ms bolt-square flash on the
      // status bar is the visual confirmation regardless of which
      // direction the cycle advanced. Flash flag is workspace-scoped
      // so only THIS window flashes; sibling windows ignore.
      //
      // Race guard: a bridge turn may have started between menu
      // build and click. Re-check `isBridgeBusy` here and fall
      // through to the locked toast instead of switching under an
      // in-flight turn, which would desync the dispatcher's wait
      // behavior from the envelope that is already out on the wire.
      if (isBridgeBusy(ctx.ws)) {
        void vscode.window.showInformationMessage(
          "Epic Handshake: wait mode is locked while a bridge turn is running. It will unlock automatically when the turn finishes."
        );
        break;
      }
      applyWaitMode(nextWaitMode(currentWaitMode()));
      if (ctx.ws) {
        try {
          writeFileAtomic(
            waitModeFlashFlagPath(workspaceHash(ctx.ws)),
            new Date().toISOString()
          );
        } catch {
          // best-effort
        }
      }
      break;
    }
    case "wait-mode-locked":
      void vscode.window.showInformationMessage(
        "Epic Handshake: wait mode is locked while a bridge turn is running. It will unlock automatically when the turn finishes."
      );
      break;
    case "manage-sessions":
      await showSessionsSubmenu({
        ws: ctx.ws,
        inFlight: ctx.inFlight,
        recoverable: ctx.recoverable,
        dispatch: handleAction,
      });
      break;
    case "repair-sessions":
      await showRepairSessionsPicker(ctx.ws, ctx.recoverable, ctx.inFlight);
      break;
    case "restart-bridge":
      await vscode.commands.executeCommand(
        "wat321.epicHandshake.restartCodexBridge"
      );
      void vscode.window.showInformationMessage(
        "Epic Handshake: bridge restarted. The active session resumes on your next prompt."
      );
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
