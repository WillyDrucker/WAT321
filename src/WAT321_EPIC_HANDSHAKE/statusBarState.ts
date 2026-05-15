import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import * as vscode from "vscode";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import {
  inboxCodexDir,
  inFlightFlagPath,
  pausedFlagPath,
  processingFlagPath,
} from "./constants";
import { workspaceHash } from "../shared/workspaceHash";

/**
 * Tiny shared utilities for the status bar layer. Both the refresh
 * loop in `statusBarItem.ts` and the menu handlers in
 * `statusBarMenus.ts` consult these. Lives in its own file to
 * eliminate the cyclic import that would otherwise exist if the
 * menus needed `isBridgeBusy` from `statusBarItem` and the status
 * bar needed menu functions from menus.
 */

/** Staleness threshold for runtime bridge state. Flags and outbound
 * envelopes older than this without a fresh heartbeat are treated
 * as crashed-mid-turn leftovers and ignored. Five minutes is well
 * past any legitimate dispatch latency (the dispatcher picks up an
 * envelope within seconds; the longest real bridge turn observed in
 * the wild is sub-10 minutes total, with heartbeats refreshing
 * every few seconds inside that window). Without this gate, a
 * stale flag from a prior crash keeps the status bar animating
 * forever - the dispatcher-side flag writers are explicit (not
 * heartbeat-style refresh), so nothing else cleans them up. */
const STALE_BRIDGE_STATE_MS = 5 * 60_000;

/** Best-effort mtime read. Returns 0 if the file is missing or
 * the stat call fails, which falls through to "treat as stale" in
 * the staleness gate (the safer side - a missing or unreadable
 * flag should not keep the widget animating). */
function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function isFlagFresh(path: string): boolean {
  if (!existsSync(path)) return false;
  return Date.now() - mtimeMs(path) < STALE_BRIDGE_STATE_MS;
}

/** Resolve the per-workspace paused flag path for the active VS Code
 * window. Returns null when no workspace folder is open (the bridge
 * is dormant in that case, so paused state is irrelevant). Reading
 * `vscode.workspace.workspaceFolders` here keeps callers free of
 * per-workspace plumbing - status-bar code that asks "are we paused?"
 * always means "in THIS window," and the active workspace is the
 * authoritative source. */
function currentPausedFlag(): string | null {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) return null;
  return pausedFlagPath(workspaceHash(ws));
}

export function isPaused(): boolean {
  const path = currentPausedFlag();
  if (!path) return false;
  return existsSync(path);
}

/** Write or remove the pause sentinel for the active workspace.
 * Called by the menu handlers on pause/resume actions. Persistent
 * across VS Code restarts by design - a paused bridge should stay
 * paused until explicitly unpaused. Per-workspace by design: pausing
 * in one VS Code window does not pause sibling windows on the same
 * machine. */
export function setPaused(paused: boolean): void {
  const path = currentPausedFlag();
  if (!path) return;
  if (paused) {
    writeFileAtomic(path, new Date().toISOString());
  } else if (existsSync(path)) {
    unlinkSync(path);
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

/** A prompt is "in flight" if any FRESH envelope sits in this
 * workspace's `inbox/codex/<wshash>/` waiting for the dispatcher to
 * process it. Stale envelopes older than `STALE_BRIDGE_STATE_MS` are
 * ignored - they represent a prior crash or abandoned dispatch the
 * dispatcher never picked up, and treating them as "in flight"
 * would keep the status bar animating forever. Per-workspace
 * partition means a primary VS Code window won't report "busy"
 * because a sibling test instance has a pending envelope - each
 * window only counts its own workspace's work. */
export function hasPendingPrompt(workspacePath: string | null): boolean {
  if (!workspacePath) return false;
  const dir = inboxCodexDir(workspaceHash(workspacePath));
  try {
    if (!existsSync(dir)) return false;
    const cutoff = Date.now() - STALE_BRIDGE_STATE_MS;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      if (mtimeMs(`${dir}/${f}`) >= cutoff) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Single source of truth for "is there an interruptable turn right
 * now?" Used by both the status bar refresh loop and every menu
 * entry that gates Cancel. Must match the window in which
 * `codexDispatcher.runTurnOnce` actually polls the cancel flag:
 * inbox has a fresh envelope waiting for dispatch OR a fresh
 * in-flight/processing flag exists. Returning flag is deliberately
 * excluded - by then the turn is complete and there is nothing to
 * interrupt.
 *
 * Staleness gate: flags older than `STALE_BRIDGE_STATE_MS` without
 * any matching fresh state are treated as crashed-mid-turn cruft
 * and ignored. The dispatcher's flag writers are explicit (not
 * heartbeat-style refresh), so without this gate a mid-turn crash
 * or VS Code restart leaves the widget animating forever.
 *
 * Flags read are workspace-scoped so a sibling VS Code instance's
 * active turn does not flip this workspace's widget to "busy." */
export function isBridgeBusy(workspacePath: string | null): boolean {
  if (!workspacePath) return false;
  const hash = workspaceHash(workspacePath);
  return (
    isFlagFresh(inFlightFlagPath(hash)) ||
    isFlagFresh(processingFlagPath(hash)) ||
    hasPendingPrompt(workspacePath)
  );
}
