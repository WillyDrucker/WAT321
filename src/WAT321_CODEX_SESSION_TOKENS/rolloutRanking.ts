import { statSync } from "node:fs";
import { readTail } from "../engine/fs/fileReaders";
import { isSameWorkspaceTree } from "../engine/fs/pathIdentity";
import {
  compareActivity,
  rankActivity,
  type ActivityRank,
} from "../shared/sessionTokens/activityRanking";
import { classifyCodexTurn } from "./codexTurnClassifier";
import { parseCwd } from "./rolloutParsers";

/**
 * Scores and ranks the rollouts `rolloutDiscovery.ts` finds for a
 * workspace, and tallies the inventory from the same list. The order
 * is the shared activity-first policy in `activityRanking.ts` (hot
 * recency, then tail activity, then mtime), so a native Codex session
 * the user is typing into wins over an idle bridge rollout whose last
 * write happens to be newer.
 */

/** How recent a rollout's mtime must be to count toward the
 * workspace inventory. 30 minutes captures "actually open" without
 * counting yesterday's leftover rollouts as part of the
 * "multi-session" surface. Same window gates the in-progress
 * sub-count. */
const INVENTORY_WINDOW_MS = 30 * 60_000;

export interface RolloutDiscoveryResult {
  /** The rollout to track, or null if no workspace match exists. */
  path: string | null;
  /** Count of rollouts in this workspace with mtime within the
   * inventory window. Drives the multi-session tooltip. */
  total: number;
  /** Subset of `total` whose tail classifies as a turn in progress
   * (`assistant-pending` or `user`). */
  inProgress: number;
  /** Every workspace-matching candidate from this walk. Empty when
   * no workspace match exists. */
  candidates: RolloutCandidate[];
}

export interface RolloutCandidate {
  path: string;
  mtime: number;
  turnState: "user" | "assistant-pending" | "assistant-done" | "unknown";
  cwd: string;
}

/** One rollout with its ranking inputs, richer than the exported
 * `RolloutCandidate`. */
export interface ScoredRollout {
  path: string;
  rank: ActivityRank;
  inProgress: boolean;
  fresh: boolean;
  turnState: RolloutCandidate["turnState"];
  cwd: string;
}

/** Stat + classify one rollout file into a ranking candidate, or null
 * when it cannot be read or its cwd does not belong to this workspace.
 * Shared by the day-window walk and the sticky-path injection so both
 * score a candidate identically. */
export function scoreRollout(
  fullPath: string,
  workspacePath: string,
  now: number
): ScoredRollout | null {
  let mtime = 0;
  try {
    mtime = statSync(fullPath).mtimeMs;
  } catch {
    return null;
  }

  const cwd = parseCwd(fullPath);
  if (!cwd) return null;
  // Bidirectional match, symmetric with Claude's walkWorkspaceSessions:
  // also matches a native session launched from a subfolder of the open
  // workspace.
  if (!isSameWorkspaceTree(workspacePath, cwd)) return null;

  // Read the tail to classify activity. Bounded to the tail window so
  // this stays cheap even on multi-MB rollouts.
  const tail = readTail(fullPath);
  const rawTurnState = tail ? classifyCodexTurn(tail) : "unknown";
  // Narrow LastEntryKind to the three states the candidate carries -
  // compact-end / interrupted collapse to unknown.
  const turnState: RolloutCandidate["turnState"] =
    rawTurnState === "user" ||
    rawTurnState === "assistant-pending" ||
    rawTurnState === "assistant-done"
      ? rawTurnState
      : "unknown";

  return {
    path: fullPath,
    rank: rankActivity(rawTurnState, mtime, now),
    inProgress: turnState === "assistant-pending" || turnState === "user",
    fresh: now - mtime <= INVENTORY_WINDOW_MS,
    turnState,
    cwd,
  };
}

/** Pick the best candidate by the shared activity ranking and tally
 * the inventory (count of fresh rollouts in workspace + those with
 * in-flight turns) from the same candidate list so the widget
 * tooltip surfaces multi-session disclosure without a second walk.
 * Returns `{ path: null, total: 0, inProgress: 0 }` on empty list. */
export function rankRollouts(candidates: ScoredRollout[]): RolloutDiscoveryResult {
  let total = 0;
  let inProgress = 0;
  for (const c of candidates) {
    if (!c.fresh) continue;
    total++;
    if (c.inProgress) inProgress++;
  }
  const exposedCandidates: RolloutCandidate[] = candidates.map((c) => ({
    path: c.path,
    mtime: c.rank.mtime,
    turnState: c.turnState,
    cwd: c.cwd,
  }));
  if (candidates.length === 0) {
    return { path: null, total: 0, inProgress: 0, candidates: exposedCandidates };
  }
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    if (compareActivity(candidates[i].rank, best.rank) > 0) best = candidates[i];
  }
  return { path: best.path, total, inProgress, candidates: exposedCandidates };
}
