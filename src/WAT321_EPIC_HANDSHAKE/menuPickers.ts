import * as vscode from "vscode";
import {
  codexDefaultsHeadline,
  codexDefaultsSubline,
} from "./codexDefaultsPicker";
import {
  makeBackItem,
  makeCancelItem,
  makeInFlightLockedItem,
  makePauseResumeItem,
  withMenuLifecycle,
  type DispatchAction,
  type Item,
} from "./menuCommon";
import { findRepairableSessions } from "./repairSessionsPicker";
import { isBridgeBusy, isPaused } from "./statusBarState";
import {
  loadBridgeThreadRecord,
  type RecoverableSession,
} from "./threadPersistence";

/**
 * Manage Codex submenu. The CODEX SESSION row opens
 * `showRecoverSessionPicker` (in `recoverSessionPicker.ts`). The
 * REPAIR SESSIONS row opens `showRepairSessionsPicker` (in
 * `repairSessionsPicker.ts`). Late-reply inbox sub-pickers live in
 * `lateReplyPickers.ts`. Each takes a `dispatch` callback so it can
 * route Pause/Resume/Cancel/Back through the same `handleAction`
 * surface as the main menu without a circular import back into
 * `statusBarMenus.ts`.
 */

export { showRecoverSessionPicker } from "./recoverSessionPicker";
export { showRepairSessionsPicker } from "./repairSessionsPicker";

export async function showSessionsSubmenu(opts: {
  ws: string | null;
  inFlight: boolean;
  recoverable: RecoverableSession[];
  dispatch: DispatchAction;
}): Promise<void> {
  const paused = isPaused();

  // Codex Defaults entry point. Combined picker for sandbox + model +
  // effort - all three are per-turn overrides on `turn/start`, so the
  // change takes effect on the next prompt without a thread reset.
  // Locks during an in-flight bridge turn because the override flags
  // are read mid-turn; switching while a turn is outstanding would
  // mean the in-flight envelope used different values than the user
  // expected. All locked rows share the same `(Disabled - Message
  // In-Flight)` suffix + lock icon so the user reads disabled state
  // consistently regardless of which row they hover.
  const inFlight = isBridgeBusy(opts.ws);
  const headline = codexDefaultsHeadline();
  const subline = codexDefaultsSubline();
  const codexDefaultsItem: Item = inFlight
    ? makeInFlightLockedItem(headline, subline)
    : {
        label: headline,
        description: subline,
        iconPath: new vscode.ThemeIcon("symbol-method"),
        action: "codex-defaults",
      };

  // CODEX SESSION row. Labels show the active S# when one exists, else
  // "Created on next prompt to Codex". Click opens the recover-session
  // picker so the user can switch among recoverable sessions; the
  // active row in that subpicker carries a green check. Locked during
  // an in-flight turn - switching the active session mid-turn would
  // leave the in-flight envelope writing to a thread the user is no
  // longer treating as active.
  const currentRecord =
    opts.ws !== null ? loadBridgeThreadRecord(opts.ws) : null;
  const currentCounter =
    currentRecord !== null && currentRecord.threadId !== null
      ? currentRecord.sessionCounter
      : null;
  const currentSessionLabel =
    currentCounter !== null
      ? `Epic Handshake Claude-to-Codex S${currentCounter}`
      : "Created on next prompt to Codex";
  const currentItemLabel = `CODEX SESSION: ${currentSessionLabel}`;
  const currentItem: Item = inFlight
    ? makeInFlightLockedItem(currentItemLabel)
    : {
        label: currentItemLabel,
        iconPath: new vscode.ThemeIcon("history"),
        action: "recover",
      };

  // Reset / delete / delete-all rotate or remove the bridge thread.
  // All three are catastrophic mid-turn: the in-flight envelope is
  // bound to the current threadId and any rotation desyncs the
  // dispatcher's state from the running Codex turn. Lock with the
  // unified suffix when in-flight.
  const resetItem: Item = inFlight
    ? makeInFlightLockedItem("RESET CODEX SESSION", "Fresh session on next prompt.")
    : {
        label: "RESET CODEX SESSION",
        description: "Fresh session on next prompt.",
        detail: "Keeps the old session visible in Codex's own history.",
        iconPath: new vscode.ThemeIcon("refresh"),
        action: "reset",
      };

  // Always rendered for layout consistency with the OpenCode menu. When
  // no active session exists the deleteCurrentCodexSession command short-
  // circuits with an info toast rather than hiding the row, so the menu
  // shape stays stable as the user moves between empty and active states.
  const deleteItemLabel =
    currentCounter !== null
      ? `DELETE CODEX SESSION (S${currentCounter})`
      : "DELETE CODEX SESSION";
  const deleteItem: Item = inFlight
    ? makeInFlightLockedItem(deleteItemLabel, "Remove the active session.")
    : {
        label: deleteItemLabel,
        description: "Remove the active session.",
        detail:
          currentCounter !== null
            ? "Deletes the currently active \"Epic Handshake\" session. Fresh session on next prompt."
            : undefined,
        iconPath: new vscode.ThemeIcon("trash"),
        action: "delete",
      };

  const deleteAllItemLabel = `DELETE ALL CODEX SESSIONS (${opts.recoverable.length})`;
  const deleteAllItem: Item = inFlight
    ? makeInFlightLockedItem(
        deleteAllItemLabel,
        opts.recoverable.length === 0
          ? "Nothing to clear right now."
          : "Removes every bridge session for this workspace."
      )
    : {
        label: deleteAllItemLabel,
        description:
          opts.recoverable.length === 0
            ? "Nothing to clear right now."
            : "Removes every bridge session for this workspace.",
        detail:
          opts.recoverable.length === 0
            ? undefined
            : "Fresh session on next prompt.",
        iconPath: new vscode.ThemeIcon("trash"),
        action: "delete-all",
      };

  // Repair surfaces sessions whose stored `session_meta.model` is not
  // in the local Codex models cache (drifted across a Codex CLI
  // upgrade that renamed or retired that slug). Conditional show -
  // hidden when nothing needs repair so the menu stays lean. Locked
  // mid-turn because repair rewrites the rollout's stored model slug,
  // which the in-flight envelope's resume already committed to.
  const repairable = findRepairableSessions(opts.ws, opts.recoverable);
  const repairItem: Item | null =
    repairable.length > 0
      ? inFlight
        ? makeInFlightLockedItem(
            `REPAIR SESSIONS (${repairable.length})`,
            "Repair stale sessions."
          )
        : {
            label: `REPAIR SESSIONS (${repairable.length})`,
            description: "Repair stale sessions.",
            detail:
              "Attempts repairs if \"Epic Handshake\" session is experiencing a problem.",
            iconPath: new vscode.ThemeIcon("tools"),
            action: "repair-sessions",
          }
      : null;

  // Ordering: BACK at top, then the unified Codex Defaults entry
  // (sandbox + model + effort live there), then session-management
  // actions. PAUSE/CANCEL repeat at the bottom of every menu so the
  // user always has a one-click escape path regardless of where they
  // navigated. All in-flight-sensitive items below use the fresh
  // `inFlight` snapshot (not `opts.inFlight`) so a turn that started
  // between the submenu open and now also locks the bottom rows and
  // the dispatched ActionContext.
  const pauseItem = makePauseResumeItem(paused, inFlight);
  const cancelItem = makeCancelItem(inFlight);
  const items: Item[] = [
    makeBackItem(),
    codexDefaultsItem,
    currentItem,
    resetItem,
    deleteItem,
    deleteAllItem,
    ...(repairItem ? [repairItem] : []),
    pauseItem,
    cancelItem,
  ];

  const pick = await withMenuLifecycle(() =>
    vscode.window.showQuickPick(items, {
      title: `Manage Codex${paused ? " (paused)" : ""}`,
      placeHolder: "Choose an action",
    })
  );
  if (!pick) return;

  await opts.dispatch(pick.action, {
    ws: opts.ws,
    lateReplies: [],
    recoverable: opts.recoverable,
    inFlight,
  });
}
