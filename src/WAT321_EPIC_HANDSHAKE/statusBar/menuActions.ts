import * as vscode from "vscode";
import type { DrainedReply } from "../../engine/inbox/inboxReader";
import type { MenuRowText } from "../../shared/ui/menuRows";
import type { RecoverableSession } from "../codexTurn/sessionRecovery";

/**
 * The action vocabulary and row shapes every Epic Handshake QuickPick
 * shares, plus the in-flight lock wrapper. The shared bottom rows
 * (pause, resume, cancel, back, separator) come from
 * `shared/ui/menuRows.ts` and take `EPIC_HANDSHAKE_MENU_TEXT` for
 * their descriptions. Sub-pickers import from here so they never
 * reach back into `statusBarMenus.ts`.
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

/** Description copy for the shared pause, resume, and cancel rows. */
export const EPIC_HANDSHAKE_MENU_TEXT: MenuRowText = {
  pause: "Blocks new prompts until you resume.",
  resume: "Re-enables Claude to Codex prompts.",
  cancel: "Request to stop current turn.",
};

/** What a value sub-picker hands back to its parent, so the parent can
 * tell "user picked a new value" from "user cancelled / paused / went
 * back" without a sentinel value. */
export type PickResult<TValue> =
  | { kind: "cancelled" }
  | { kind: "picked"; value: TValue };

/** Context passed to `handleAction` so sub-menus and the main menu
 * route through one dispatch surface without re-deriving state. */
export interface ActionContext {
  ws: string | null;
  lateReplies: DrainedReply[];
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
