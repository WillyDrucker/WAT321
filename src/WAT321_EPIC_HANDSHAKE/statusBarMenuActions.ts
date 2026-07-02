import * as vscode from "vscode";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { workspaceHash } from "../shared/workspaceHash";
import { showCodexDefaultsPicker } from "./codexDefaultsPicker";
import { waitModeFlashFlagPath } from "./constants";
import {
  discardAllLateReplies,
  showLateRepliesPicker,
} from "./lateReplyPickers";
import type {
  Action,
  ActionContext,
  DispatchAction,
} from "./menuCommon";
import {
  showRecoverSessionPicker,
  showRepairSessionsPicker,
  showSessionsSubmenu,
} from "./menuPickers";
import {
  showLocalLLMSessionsPicker,
  showOpenCodeSessionsPicker,
} from "./openCodeSessionsPicker";
import { isBridgeBusy, setPaused } from "./statusBarState";
import { clearBridgeErrorState } from "./threadPersistence";
import { writeCancelFlag } from "./turnFlags";
import {
  applyWaitMode,
  currentWaitMode,
  nextWaitMode,
} from "./waitMode";

/**
 * Single dispatch surface for every Epic Handshake menu action.
 * Main menu and sub-pickers both route here so each action has
 * exactly one switch. Re-entry into the main menu (for `back` and
 * `in-flight-info`) is injected as `deps.reopenMainMenu` to avoid a
 * circular import with `statusBarMenus.ts`.
 *
 * The locked-mid-turn toast appears verbatim for every action that
 * mutates dispatcher / thread state - sub-menu rows that render as
 * locked already route through `in-flight-locked` for the same toast,
 * but the action-time guards here are race protection for the window
 * between menu build and click.
 */

const LOCKED_MID_TURN_MESSAGE =
  "Epic Handshake: this action is locked while a bridge turn is in flight. Wait for the turn to finish, or use Cancel / Restart Epic Handshake Bridge if the turn is stuck.";

function showLockedToast(): void {
  void vscode.window.showInformationMessage(LOCKED_MID_TURN_MESSAGE);
}

export interface MenuDispatchDeps {
  /** Re-open the main menu (used by `back`, `in-flight-info`, and
   * the sub-picker `back` returns). */
  reopenMainMenu(opts: { inFlight: boolean }): Promise<void>;
}

export function createMenuDispatch(deps: MenuDispatchDeps): DispatchAction {
  const dispatch = async (
    action: Action,
    ctx: ActionContext
  ): Promise<void> => {
    switch (action) {
      case "pause":
        setPaused(true);
        break;
      case "resume":
        setPaused(false);
        break;
      case "reset":
        // Race guard: the submenu renders this row as locked via
        // `makeInFlightLockedItem` when in-flight, but a turn that
        // started in the window between QuickPick build and click
        // would otherwise let rotation fire on the same thread the
        // in-flight envelope is bound to.
        if (isBridgeBusy(ctx.ws)) {
          showLockedToast();
          break;
        }
        await vscode.commands.executeCommand(
          "wat321.epicHandshake.resetCodexSession"
        );
        break;
      case "delete":
        if (isBridgeBusy(ctx.ws)) {
          showLockedToast();
          break;
        }
        await vscode.commands.executeCommand(
          "wat321.epicHandshake.deleteCodexSession"
        );
        break;
      case "delete-all":
        if (isBridgeBusy(ctx.ws)) {
          showLockedToast();
          break;
        }
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
          await showLateRepliesPicker(ctx.lateReplies, ctx.inFlight, dispatch);
        }
        break;
      case "discard-mail":
        await discardAllLateReplies(ctx.lateReplies);
        break;
      case "recover":
        if (isBridgeBusy(ctx.ws)) {
          showLockedToast();
          break;
        }
        if (ctx.ws) {
          await showRecoverSessionPicker(
            ctx.ws,
            ctx.recoverable,
            ctx.inFlight,
            dispatch
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
        // (so the user can always find it), but clicking outside an
        // active turn just toasts "nothing to cancel" and skips the
        // flag write. Writing it without an active runTurnOnce to
        // consume it would leave a stale sentinel that would interrupt
        // the next turn.
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
        // Sandbox + model + effort live as per-turn overrides written
        // by the picker - switching while a turn is outstanding means
        // the in-flight envelope used one set of values while the user
        // expected another.
        if (isBridgeBusy(ctx.ws)) {
          void vscode.window.showInformationMessage(
            "Epic Handshake: Codex Defaults are locked while a bridge turn is running. They will unlock automatically when the turn finishes."
          );
          break;
        }
        await showCodexDefaultsPicker(dispatch, {
          ws: ctx.ws,
          lateReplies: [],
          recoverable: ctx.recoverable,
          inFlight: ctx.inFlight,
        });
        break;
      case "wait-mode-toggle": {
        // Binary toggle between Adaptive and Fire-and-Forget. Standard
        // is internal-only - if `currentWaitMode` returns "standard" the
        // toggle resolves to FF and the next click grounds to Adaptive.
        // The 2500ms bolt-square flash on the status bar is the visual
        // confirmation - flag is workspace-scoped so only THIS window
        // flashes. Race guard: a bridge turn may have started between
        // menu build and click - re-check here and route to the locked
        // toast instead of switching mid-flight.
        if (isBridgeBusy(ctx.ws)) {
          void vscode.window.showInformationMessage(
            "Epic Handshake: wait mode is locked while a bridge turn is running. It will unlock automatically when the turn finishes."
          );
          break;
        }
        if (ctx.ws) {
          applyWaitMode(nextWaitMode(currentWaitMode(ctx.ws)), ctx.ws);
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
      case "in-flight-locked":
        // Unified toast for any locked-mid-turn row. The label already
        // says "Disabled - Message In-Flight" - this toast explains why
        // and reminds the user that cancel / restart-bridge remain
        // available if the turn is truly stuck.
        showLockedToast();
        break;
      case "in-flight-info":
        // Informational only. Re-open the menu so the operator can
        // act on what they just saw without a second widget click.
        await deps.reopenMainMenu({ inFlight: isBridgeBusy(ctx.ws) });
        break;
      case "manage-sessions":
        await showSessionsSubmenu({
          ws: ctx.ws,
          inFlight: ctx.inFlight,
          recoverable: ctx.recoverable,
          dispatch,
        });
        break;
      case "manage-opencode-sessions":
        if ((await showOpenCodeSessionsPicker()) === "back") {
          await deps.reopenMainMenu({ inFlight: isBridgeBusy(ctx.ws) });
        }
        break;
      case "manage-local-llm-sessions":
        if ((await showLocalLLMSessionsPicker()) === "back") {
          await deps.reopenMainMenu({ inFlight: isBridgeBusy(ctx.ws) });
        }
        break;
      case "repair-sessions":
        if (isBridgeBusy(ctx.ws)) {
          showLockedToast();
          break;
        }
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
        // Sub-menus invoke this to return to the main menu so the
        // user doesn't have to close + re-click the widget. inFlight
        // is re-read so the menu reflects current state, not stale
        // state from when the sub-menu opened.
        await deps.reopenMainMenu({ inFlight: isBridgeBusy(ctx.ws) });
        break;
    }
  };
  return dispatch;
}
