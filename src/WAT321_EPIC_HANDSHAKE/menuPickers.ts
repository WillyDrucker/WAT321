import * as vscode from "vscode";
import {
  codexDefaultsHeadline,
  codexDefaultsSubline,
} from "./codexDefaultsPicker";
import {
  makeBackItem,
  makeCancelItem,
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
  // expected.
  const inFlight = isBridgeBusy(opts.ws);
  const headline = codexDefaultsHeadline();
  const subline = codexDefaultsSubline();
  const codexDefaultsItem: Item = {
    label: inFlight ? `${headline} (locked during turn)` : headline,
    description: subline,
    iconPath: new vscode.ThemeIcon("symbol-method"),
    action: "codex-defaults",
  };

  // CODEX SESSION row. Labels show the active S# when one exists, else
  // "Created on next prompt to Codex". Click opens the recover-session
  // picker so the user can switch among recoverable sessions; the
  // active row in that subpicker carries a green check.
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
  const currentItem: Item = {
    label: `CODEX SESSION: ${currentSessionLabel}`,
    iconPath: new vscode.ThemeIcon("history"),
    action: "recover",
  };

  const resetItem: Item = {
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
  const deleteItem: Item = {
    label:
      currentCounter !== null
        ? `DELETE CODEX SESSION (S${currentCounter})`
        : "DELETE CODEX SESSION",
    description: "Remove the active session.",
    detail:
      currentCounter !== null
        ? "Deletes the currently active \"Epic Handshake\" session. Fresh session on next prompt."
        : undefined,
    iconPath: new vscode.ThemeIcon("trash"),
    action: "delete",
  };

  const deleteAllItem: Item = {
    label: `DELETE ALL CODEX SESSIONS (${opts.recoverable.length})`,
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
  // hidden when nothing needs repair so the menu stays lean.
  const repairable = findRepairableSessions(opts.ws, opts.recoverable);
  const repairItem: Item | null =
    repairable.length > 0
      ? {
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
  // navigated.
  const pauseItem = makePauseResumeItem(paused, opts.inFlight);
  const cancelItem = makeCancelItem(opts.inFlight);
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
    inFlight: opts.inFlight,
  });
}
