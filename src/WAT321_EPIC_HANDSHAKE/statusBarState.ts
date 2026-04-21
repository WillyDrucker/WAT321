import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import * as vscode from "vscode";
import {
  inboxCodexDir,
  inFlightFlagPath,
  PAUSED_FLAG_PATH,
  processingFlagPath,
} from "./constants";
import { workspaceHash } from "./workspaceHash";

/**
 * Tiny shared utilities for the status bar layer. Both the refresh
 * loop in `statusBarItem.ts` and the menu handlers in
 * `statusBarMenus.ts` consult these. Lives in its own file to
 * eliminate the cyclic import that would otherwise exist if the
 * menus needed `isBridgeBusy` from `statusBarItem` and the status
 * bar needed menu functions from menus.
 */

export function isPaused(): boolean {
  return existsSync(PAUSED_FLAG_PATH);
}

/** Write or remove the pause sentinel. Called by the menu handlers
 * on pause/resume actions. Persistent across VS Code restarts by
 * design - a paused bridge should stay paused until explicitly
 * unpaused. */
export function setPaused(paused: boolean): void {
  if (paused) {
    writeFileSync(PAUSED_FLAG_PATH, new Date().toISOString(), "utf8");
  } else if (existsSync(PAUSED_FLAG_PATH)) {
    unlinkSync(PAUSED_FLAG_PATH);
  }
}

/** Active workspace path for this VS Code window, or null when no
 * folder is open. Status bar callbacks need it to scope inbox /
 * heartbeat reads to the current workspace. Read from
 * `vscode.workspace.workspaceFolders` rather than threaded through
 * every callback so menu handlers, the response-complete listener,
 * and the refresh tick all use the same source of truth. */
export function currentWorkspacePath(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

/** A prompt is "in flight" if any envelope sits in this workspace's
 * `inbox/codex/<wshash>/` waiting for the dispatcher to process it.
 * Per-workspace partition means a primary VS Code window won't
 * report "busy" because a sibling test instance has a pending
 * envelope - each window only counts its own workspace's work. */
export function hasPendingPrompt(workspacePath: string | null): boolean {
  if (!workspacePath) return false;
  const dir = inboxCodexDir(workspaceHash(workspacePath));
  try {
    if (!existsSync(dir)) return false;
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    return files.length > 0;
  } catch {
    return false;
  }
}

/** Single source of truth for "is there an interruptable turn right
 * now?" Used by both the status bar refresh loop and every menu
 * entry that gates Cancel. Must match the window in which
 * `codexDispatcher.runTurnOnce` actually polls the cancel flag:
 * inbox has an envelope waiting for dispatch OR a turn is in-flight
 * OR streaming deltas are landing. Returning flag is deliberately
 * excluded - by then the turn is complete and there is nothing to
 * interrupt.
 *
 * Flags read are workspace-scoped so a sibling VS Code instance's
 * active turn does not flip this workspace's widget to "busy." */
export function isBridgeBusy(workspacePath: string | null): boolean {
  if (!workspacePath) return false;
  const hash = workspaceHash(workspacePath);
  return (
    existsSync(inFlightFlagPath(hash)) ||
    existsSync(processingFlagPath(hash)) ||
    hasPendingPrompt(workspacePath)
  );
}
