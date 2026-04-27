import { existsSync, statSync, unlinkSync } from "node:fs";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import {
  cancelFlagPath,
  inFlightFlagPath,
  processingFlagPath,
  returningFlagPath,
  suppressCodexToastFlagPath,
} from "./constants";
import { workspaceHash } from "./workspaceHash";

/** Drop the cancel sentinel for this workspace. The status-bar
 * menu's Cancel action calls this; `runTurnOnce` polls the sentinel
 * every 500ms inside the active turn promise and interrupts Codex
 * on detect. Workspace-scoped so a sibling VS Code instance's turn
 * is never cancelled by a click in this window. */
export function writeCancelFlag(workspacePath: string): void {
  try {
    writeFileAtomic(
      cancelFlagPath(workspaceHash(workspacePath)),
      new Date().toISOString()
    );
  } catch {
    // best-effort - caller surfaces the error
  }
}

/** How long a suppress-codex-toast sentinel stays valid after the
 * dispatcher writes it. Codex's transcript flush typically lands within
 * a second or two of `turn/completed`, but a slow write can take longer
 * - 30s covers worst-observed cases without risking suppression of a
 * later, unrelated Codex turn that happens to land in the same window. */
const SUPPRESS_CODEX_TOAST_FRESHNESS_MS = 30_000;

/**
 * Flag files the dispatcher writes during a Codex turn so the status
 * bar (a different process boundary concern: extension window vs
 * background dispatcher) can render the right animation without
 * needing a direct event channel.
 *
 *   in-flight.<wshash>.flag   - present from turn dispatch start
 *                               until clear
 *   processing.<wshash>.flag  - present once Codex emits its first
 *                               streaming delta; cleared on turn
 *                               completion/failure
 *   returning.<wshash>.flag   - written on success; auto-cleared
 *                               5000ms later
 *
 * All flags are per-workspace so a turn in workspace A never makes
 * workspace B's status bar render "busy." Before partitioning, the
 * shared root-level flags were the source of the cross-window bleed
 * caught during isolated-instance testing.
 *
 * All flags are best-effort. A missed write only costs a missed
 * animation frame; never block the turn on flag I/O.
 */

export function writeInFlightFlag(workspacePath: string): void {
  try {
    writeFileAtomic(
      inFlightFlagPath(workspaceHash(workspacePath)),
      new Date().toISOString()
    );
  } catch {
    // best-effort; status bar will just miss the in-flight signal
  }
}

export function clearInFlightFlag(workspacePath: string): void {
  const path = inFlightFlagPath(workspaceHash(workspacePath));
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}

export function writeProcessingFlag(workspacePath: string): void {
  try {
    writeFileAtomic(
      processingFlagPath(workspaceHash(workspacePath)),
      new Date().toISOString()
    );
  } catch {
    // best-effort
  }
}

export function clearProcessingFlag(workspacePath: string): void {
  const path = processingFlagPath(workspaceHash(workspacePath));
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}

/** Drop the suppress-codex-toast sentinel for this workspace. The
 * dispatcher calls this on successful turn completion (and on rollout-
 * recovery resolution) so the toast notifier can suppress the Codex
 * "response complete" toast that arrives moments later from Codex's
 * own transcript watcher - the user already saw the bridge result in
 * Claude and a second toast about the same thing is noise. Replaces
 * the older 5s `returning` flag heuristic which missed slow transcript
 * writes. */
export function writeSuppressCodexToast(workspacePath: string): void {
  try {
    writeFileAtomic(
      suppressCodexToastFlagPath(workspaceHash(workspacePath)),
      new Date().toISOString()
    );
  } catch {
    // best-effort
  }
}

/** Read-and-delete the suppress-codex-toast sentinel for this
 * workspace. Returns true if a fresh sentinel was found (and consumed)
 * - the caller should suppress the imminent Codex toast. Returns false
 * if no sentinel exists or the existing one is older than the
 * freshness window (a stale flag from a long-completed turn must not
 * suppress a later, unrelated Codex toast). */
export function consumeRecentCodexCompletion(workspacePath: string): boolean {
  const path = suppressCodexToastFlagPath(workspaceHash(workspacePath));
  if (!existsSync(path)) return false;
  let fresh = false;
  try {
    const ageMs = Date.now() - statSync(path).mtimeMs;
    fresh = ageMs <= SUPPRESS_CODEX_TOAST_FRESHNESS_MS;
  } catch {
    // best-effort - if stat fails, treat as stale and just delete
  }
  try {
    unlinkSync(path);
  } catch {
    // best-effort
  }
  return fresh;
}

/** Wipe every per-workspace runtime flag the dispatcher writes during
 * a turn. Used by the "Restart Codex Bridge" main-menu action after
 * force-killing the app-server so a stuck-state can be cleared in one
 * pass. Preserves user-data flags (paused, fire-and-forget, adaptive,
 * codex-full-access, late-reply envelopes, thread record) - those
 * represent intentional state, not stale runtime cruft.
 *
 * Per-workspace by design: a sibling VS Code instance's bridge stays
 * untouched. */
export function clearBridgeRuntimeFlags(workspacePath: string): void {
  const hash = workspaceHash(workspacePath);
  const removeIfExists = (path: string): void => {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // best-effort
    }
  };
  removeIfExists(inFlightFlagPath(hash));
  removeIfExists(processingFlagPath(hash));
  removeIfExists(returningFlagPath(hash));
  removeIfExists(cancelFlagPath(hash));
  removeIfExists(suppressCodexToastFlagPath(hash));
}

/** Write the returning flag and schedule its cleanup 3000ms later.
 * The unref'd timer lets the dispatcher shut down without waiting.
 * 3s aligns with `STAGE_LATCH_MS["complete"]` and the walker's
 * stage 5 + post-walk hold, so the returning-flag fallback (used in
 * non-adaptive modes that bypass the walker) reads as the same
 * 3-second beat the rest of the bridge UI uses. */
export function writeReturningFlag(workspacePath: string): void {
  const path = returningFlagPath(workspaceHash(workspacePath));
  try {
    writeFileAtomic(path, new Date().toISOString());
    const t = setTimeout(() => {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // best-effort
      }
    }, 3_000);
    t.unref?.();
  } catch {
    // best-effort
  }
}
