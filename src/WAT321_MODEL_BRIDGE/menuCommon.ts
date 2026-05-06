import * as vscode from "vscode";

/**
 * Shared QuickPick item factories for the Model Bridge click menu.
 * Mirrors `WAT321_EPIC_HANDSHAKE/menuCommon.ts` so the two bridges
 * present a consistent visual vocabulary: 🔵 BACK at the top of every
 * submenu, 🟢/🟡 PAUSE/RESUME and 🔴 CANCEL at the bottom of every
 * menu, structured rows in between.
 *
 * Color emoji prefixes carry the affordance because VS Code's
 * QuickPickItem icon API does not honor per-row tinting; the Unicode
 * circles read at a glance even when the workbench codicons are all
 * monochrome.
 */

type Item = vscode.QuickPickItem & { action: string };

/** Pause / Resume factory. Always shown at the bottom of every menu
 * so the user can pause future dispatches mid-task. Pause refuses
 * NEW tool calls; the in-flight call keeps running and finishes
 * normally. The drain tools (`model_bridge_inbox`, `model_bridge_list`)
 * stay reachable while paused. */
export function makePauseResumeItem(paused: boolean): Item {
  return paused
    ? {
        label: "🟢 RESUME",
        description: "Re-enable Model Bridge tool calls.",
        iconPath: new vscode.ThemeIcon("wat321-square-play"),
        action: "resume",
      }
    : {
        label: "🟡 PAUSE",
        description: "Block new tool calls until you resume.",
        iconPath: new vscode.ThemeIcon("wat321-square-pause"),
        action: "pause",
      };
}

/** Cancel factory. Drops a sentinel `channel.mjs` observes and
 * aborts the active call against. Idempotent on no-op when nothing
 * is in flight - channel.mjs treats a stale flag as already-handled
 * and clears it. */
export function makeCancelItem(): Item {
  return {
    label: "🔴 CANCEL",
    description: "Abort the in-flight tool call.",
    iconPath: new vscode.ThemeIcon("wat321-square-error"),
    action: "cancel",
  };
}

/** BACK navigation row for sub-menus. Blue circle matches the
 * navigation-vs-action vocabulary the bottom row uses (yellow pause,
 * red cancel, green resume). */
export function makeBackItem(): Item {
  return {
    label: "🔵 BACK",
    iconPath: new vscode.ThemeIcon("wat321-square-arrow-left"),
    action: "back",
  };
}

/** Separator row factory. Centralized so every menu uses the same
 * shape and label-empty convention. */
export function makeSeparator(): vscode.QuickPickItem {
  return { label: "", kind: vscode.QuickPickItemKind.Separator };
}
