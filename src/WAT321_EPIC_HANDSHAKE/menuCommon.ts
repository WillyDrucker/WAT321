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
  | "codex-defaults"
  | "manage-sessions"
  | "manage-opencode-sessions"
  | "manage-local-llm-sessions"
  | "repair-sessions"
  | "in-flight-info"
  | "in-flight-locked"
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

/** Pass-through wrapper for QuickPick opens. Retained as the single
 * seam every menu call site funnels through - the body is a no-op
 * today and is a candidate for inlining if a future audit confirms
 * no seam is needed. */
export async function withMenuLifecycle<T>(fn: () => Thenable<T>): Promise<T> {
  return fn();
}

/** Pause/Resume factory. Always shown so the user can pause future
 * dispatches mid-turn (only blocks NEW prompts - the in-flight turn
 * keeps running). RESUME shows when the bridge is currently paused.
 * Color circle prefix (yellow for pause, green for resume) reads at
 * a glance even when the icon glyph is monochrome - VS Code's
 * QuickPickItem icon API does not honor per-row tinting. */
export function makePauseResumeItem(
  paused: boolean,
  _inFlight: boolean
): Item {
  return paused
    ? {
        label: "🟢 RESUME",
        description: "Re-enables Claude to Codex prompts.",
        iconPath: new vscode.ThemeIcon("wat321-square-play"),
        action: "resume",
      }
    : {
        label: "🟡 PAUSE",
        description: "Blocks new prompts until you resume.",
        iconPath: new vscode.ThemeIcon("wat321-square-pause"),
        action: "pause",
      };
}

/** Cancel factory. Always shown - the action handler checks
 * `isBridgeBusy` at click time and shows a "nothing to cancel" toast
 * when there's no active turn rather than writing a stale cancel flag
 * that would interrupt the next dispatch. Red circle prefix marks it
 * as the destructive option in any menu. */
export function makeCancelItem(_inFlight: boolean): Item {
  return {
    label: "🔴 CANCEL",
    description: "Request to stop current turn.",
    iconPath: new vscode.ThemeIcon("wat321-square-error"),
    action: "cancel",
  };
}

/** Back-to-main-menu navigation item for sub-menus. Blue circle
 * prefix matches the colored-bullet vocabulary the bottom row uses
 * (yellow pause, red cancel, green resume) - blue is reserved for
 * "navigation" rather than "action". */
export function makeBackItem(): Item {
  return {
    label: "🔵 BACK",
    iconPath: new vscode.ThemeIcon("wat321-square-arrow-left"),
    action: "back",
  };
}

/** Wrap an action item as locked-during-turn. Used by every destructive
 * submenu row (reset / delete / delete-all / recover / repair / codex
 * defaults / wait mode) when a bridge turn is in flight so the user
 * sees a consistent disabled marker and gets a clear toast on click
 * instead of triggering a thread-rotating action mid-stream that would
 * desync the in-flight envelope from the new state.
 *
 * QuickPickItem has no per-row text color, so the visual treatment is:
 * an explicit ` (Disabled - Message In-Flight)` suffix on the label,
 * a lock icon, and a description that explains the lock. Click routes
 * to the `in-flight-locked` action which surfaces the unified toast. */
export function makeInFlightLockedItem(
  originalLabel: string,
  description?: string
): Item {
  return {
    label: `${originalLabel} (Disabled - Message In-Flight)`,
    description: description ?? "Unlocks automatically when the bridge turn finishes.",
    iconPath: new vscode.ThemeIcon("lock"),
    action: "in-flight-locked",
  };
}
