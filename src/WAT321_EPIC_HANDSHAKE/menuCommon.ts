import * as vscode from "vscode";
import type { LateReply } from "./lateReplyInbox";
import type { RecoverableSession } from "./threadPersistence";

/**
 * Shared types, item factories, and lifecycle plumbing every Epic
 * Handshake QuickPick reuses. Split out of `statusBarMenus.ts` so
 * sub-pickers can grab the same factories without importing back
 * into the main menu file.
 *
 * Lifecycle hooks let the status bar item suppress its tooltip while
 * any menu is open plus a brief grace window after close so action
 * toasts land without the tooltip racing in over them. Module-scoped
 * so sub-menus can call `withMenuLifecycle` without threading hooks
 * through every signature.
 */

/** All user-facing actions that any menu (main or submenu) can fire.
 * Declared once here so factories produce items with the right action
 * type and sub-menus carry through without drift. */
export type Action =
  | "reset"
  | "delete"
  | "delete-all"
  | "pause"
  | "resume"
  | "retrieve"
  | "discard-mail"
  | "recover"
  | "clear-error"
  | "cancel"
  | "restart-bridge"
  | "wait-mode-toggle"
  | "wait-mode-locked"
  | "codex-defaults"
  | "manage-sessions"
  | "repair-sessions"
  | "back";

export type Item = vscode.QuickPickItem & { action: Action };

/** Context passed to `handleAction` so sub-menus and the main menu
 * route through one dispatch surface without re-deriving state. */
export interface ActionContext {
  ws: string | null;
  lateReplies: LateReply[];
  recoverable: RecoverableSession[];
  inFlight: boolean;
}

/** Pickers call back into the main file's dispatch via this signature
 * to avoid a circular import. The main file passes its own
 * `handleAction` as the value. */
export type DispatchAction = (
  action: Action,
  ctx: ActionContext
) => Promise<void>;

/** Pass-through wrapper for QuickPick opens. Originally carried a
 * lifecycle-hook plumbing layer that suppressed the bridge widget
 * tooltip while a menu was open and during the action toast that
 * followed. The bridge widget no longer renders a tooltip at all, so
 * the hooks are dead code. The wrapper stays in place across all
 * menu call sites so a future lifecycle need (telemetry, locking,
 * etc.) can be retrofitted without touching every QuickPick caller. */
export async function withMenuLifecycle<T>(fn: () => Thenable<T>): Promise<T> {
  return fn();
}

/** Pause/Resume factory. Hidden when a turn is in-flight so the user
 * can't pause mid-dispatch - they have to Cancel first. The status bar
 * widget conveys color via icon, so the menu rows stay text-only. */
export function makePauseResumeItem(
  paused: boolean,
  inFlight: boolean
): Item | null {
  if (!paused && inFlight) return null;
  return paused
    ? {
        label: "RESUME",
        description: "Re-enables Claude to Codex prompts.",
        iconPath: new vscode.ThemeIcon("wat321-square-play"),
        action: "resume",
      }
    : {
        label: "PAUSE",
        description: "Blocks new prompts until you resume.",
        iconPath: new vscode.ThemeIcon("wat321-square-pause"),
        action: "pause",
      };
}

/** Cancel factory. Always shown - the action handler checks
 * `isBridgeBusy` at click time and shows a "nothing to cancel" toast
 * when there's no active turn rather than writing a stale cancel flag
 * that would interrupt the next dispatch. */
export function makeCancelItem(_inFlight: boolean): Item {
  return {
    label: "CANCEL",
    description: "Request to stop current turn.",
    iconPath: new vscode.ThemeIcon("wat321-square-error"),
    action: "cancel",
  };
}

/** Back-to-main-menu navigation item for sub-menus. */
export function makeBackItem(): Item {
  return {
    label: "BACK",
    iconPath: new vscode.ThemeIcon("wat321-square-arrow-left"),
    action: "back",
  };
}
