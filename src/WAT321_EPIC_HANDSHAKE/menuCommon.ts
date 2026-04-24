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
  | "wait-mode-toggle"
  | "wait-mode-locked"
  | "permissions-toggle"
  | "manage-sessions"
  | "repair-sessions"
  | "show-status"
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

let menuOnOpen: (() => void) | null = null;
let menuOnClose: ((picked: boolean) => void) | null = null;

export function setMenuLifecycleHooks(hooks: {
  onOpen: () => void;
  onClose: (picked: boolean) => void;
}): void {
  menuOnOpen = hooks.onOpen;
  menuOnClose = hooks.onClose;
}

/** Wrap a QuickPick open with the lifecycle hooks. `onClose` receives
 * `picked = true` when the user selected an item, `false` when they
 * dismissed with ESC or clicked away. The status-bar tooltip-suppress
 * window only engages on `picked = true` so the tooltip stays fully
 * functional for users who just browse the menu without acting. */
export async function withMenuLifecycle<T>(fn: () => Thenable<T>): Promise<T> {
  menuOnOpen?.();
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    menuOnClose?.(false);
    throw err;
  }
  // `undefined` from showQuickPick means dismiss; any other value
  // means an item was picked.
  menuOnClose?.(result !== undefined);
  return result;
}

/** Pause/Resume factory. Carried through sub-menus so the user can
 * pause without navigating back. Pause uses Claude blue and Resume
 * uses green to telegraph the state-flip direction at a glance.
 * Hidden when a turn is in-flight so the user can't pause mid-dispatch -
 * they have to Cancel first. */
export function makePauseResumeItem(
  paused: boolean,
  inFlight: boolean
): Item | null {
  if (!paused && inFlight) return null;
  return paused
    ? {
        label: "🟢 Resume bridge",
        description: "Re-enable Claude to Codex prompts.",
        detail:
          "New prompts from Claude will dispatch to Codex again. Any prompt Claude queued while paused still has to be sent from Claude's side; pausing does not buffer prompts.",
        // Emoji prefix matches the pause/cancel pattern. VS Code
        // QuickPick ignores iconPath ThemeColor (Issue #72489), so
        // colored codicons via the ThemeIcon path would not render.
        // Emoji renders via the OS font stack and is guaranteed
        // green across every theme.
        iconPath: new vscode.ThemeIcon("wat321-square-play"),
        action: "resume",
      }
    : {
        label: "🟡 Pause bridge",
        description: "Block new prompts until you resume.",
        detail:
          "New Claude to Codex prompts get a short \"bridge paused\" reply instead of dispatching. Any turn already in flight runs to completion. The widget shows the paused state so you can tell at a glance; resume returns to normal dispatch.",
        // Emoji prefix instead of codicon. Web research confirmed
        // VS Code does not apply ThemeColor to QuickPickItem iconPath
        // (Issue #72489 - open since 2019) and inline codicon colors
        // hit a CSS `!important` specificity wall (#211885). Emojis
        // render via the OS font stack, completely outside VS Code's
        // theming, so the yellow is guaranteed to show up regardless
        // of theme, focus state, or VS Code version.
        iconPath: new vscode.ThemeIcon("wat321-square-pause"),
        action: "pause",
      };
}

/** Cancel factory. Carried through sub-menus. Red icon flags this as
 * the destructive stop-the-world action. Fully unconditional - the
 * item renders identically whether a turn is in-flight or not so the
 * user always knows it's available. The action handler checks
 * `isBridgeBusy` at click time and shows a "nothing to cancel" toast
 * when there's no active turn rather than writing a stale cancel flag
 * that would interrupt the next dispatch. */
export function makeCancelItem(_inFlight: boolean): Item {
  return {
    label: "🔴 Cancel in-flight prompt",
    description: "Ask Codex to stop the current turn.",
    detail:
      "Sends interrupt. Codex stops before next model round. Claude gets a \"cancelled by user\" reply within ~1s.",
    // Red emoji prefix. Same reasoning as pause - VS Code QuickPick
    // ignores iconPath ThemeColor (Issue #72489) and codicon colors
    // hit a CSS !important wall (#211885). Emoji renders in OS font,
    // guaranteed red across every theme and version.
    iconPath: new vscode.ThemeIcon("wat321-square-error"),
    action: "cancel",
  };
}

/** Back-to-main-menu navigation item for sub-menus. */
export function makeBackItem(): Item {
  return {
    label: "Back",
    description: "Return to the main menu.",
    iconPath: new vscode.ThemeIcon("wat321-square-arrow-left"),
    action: "back",
  };
}
