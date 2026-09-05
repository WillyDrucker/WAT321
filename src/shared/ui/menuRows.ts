import * as vscode from "vscode";

/**
 * The QuickPick rows every WAT321 menu shares, so the Epic Handshake
 * and OpenCode Routes menus present one visual vocabulary: 🔵 BACK at
 * the top of a submenu, 🟡 PAUSE or 🟢 RESUME and 🔴 CANCEL at the
 * bottom, structured rows in between. Color emoji prefixes carry the
 * affordance because VS Code's QuickPickItem icon API does not honor
 * per-row tinting, so the circles read even when every codicon is
 * monochrome. Each tier passes its own `MenuRowText` for descriptions.
 */

/** Description copy a tier shows on its shared rows. */
export interface MenuRowText {
  pause: string;
  resume: string;
  cancel: string;
}

type MenuRow<TAction extends string> = vscode.QuickPickItem & { action: TAction };

/** Pause or Resume row. Always shown so the user can pause future
 * dispatches mid-turn. Pause only blocks NEW prompts or tool calls,
 * the in-flight one keeps running. RESUME shows while paused. */
export function makePauseResumeItem(
  paused: boolean,
  text: MenuRowText
): MenuRow<"pause" | "resume"> {
  return paused
    ? {
        label: "🟢 RESUME",
        description: text.resume,
        iconPath: new vscode.ThemeIcon("wat321-square-play"),
        action: "resume",
      }
    : {
        label: "🟡 PAUSE",
        description: text.pause,
        iconPath: new vscode.ThemeIcon("wat321-square-pause"),
        action: "pause",
      };
}

/** Cancel row. Always shown. The action handler decides at click time
 * whether anything is in flight, so an idle click surfaces a toast
 * instead of leaving a stale cancel flag for the next dispatch. */
export function makeCancelItem(text: MenuRowText): MenuRow<"cancel"> {
  return {
    label: "🔴 CANCEL",
    description: text.cancel,
    iconPath: new vscode.ThemeIcon("wat321-square-error"),
    action: "cancel",
  };
}

/** Back-to-parent navigation row. Blue is reserved for navigation
 * rather than action in the colored-bullet vocabulary. */
export function makeBackItem(): MenuRow<"back"> {
  return {
    label: "🔵 BACK",
    iconPath: new vscode.ThemeIcon("wat321-square-arrow-left"),
    action: "back",
  };
}

/** Separator row, labeled or blank. QuickPick reserves `kind` for
 * separators, which is why row discriminators elsewhere are named
 * `rowKind` or `rowType`. */
export function makeSeparator(label = ""): vscode.QuickPickItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}
