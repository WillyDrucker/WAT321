import type { LastEntryKind } from "../turnState";

/**
 * Activity-first ranking shared by the Claude and Codex session
 * discovery walks. Ranking is activity-first, not mtime-first: in a
 * workspace where the Epic Handshake bridge writes rollouts on most
 * prompts, the bridge wins pure mtime competition against a freshly
 * typed-into native session and leaves the user's own session
 * invisible to the widget. Each candidate's tail is classified
 * instead, and mtime only breaks ties.
 */

/** Activity weight per tail classification. An in-flight assistant
 * turn is the strongest signal, a pending user prompt the next, and a
 * done, aborted, compacted, or unknown tail is idle. */
const ACTIVITY_SCORE: Partial<Record<LastEntryKind, number>> = {
  "assistant-pending": 3,
  user: 2,
  "assistant-done": 1,
};

/** Freshness gate for the activity score. A tail that still classifies
 * as `assistant-pending` but whose mtime is older than this is treated
 * as stale (score forced to 0) so an orphaned mid-turn transcript from
 * days ago cannot outrank a freshly active session. 5 minutes covers
 * the longest reasonable in-flight turn. Candidates outside the window
 * still compete on mtime. */
const ACTIVITY_FRESHNESS_MS = 5 * 60_000;

/** Hot-recency window. A transcript written within it is the strongest
 * "user is here right now" signal the file system gives, so candidates
 * inside it outrank candidates outside regardless of activity score.
 * Trade-off: a turn that goes silent for longer than this (deep
 * reasoning with no writes, slow tool dispatch) drops out of "hot"
 * even though the user is still waiting. Longer than a typical
 * between-write gap during normal turns, short enough that a stale
 * background session loses preference quickly once the user moves on. */
const HOT_RECENCY_MS = 60_000;

export interface ActivityRank {
  mtime: number;
  activity: number;
  isHot: boolean;
}

/** Score one candidate from its tail classification and mtime. */
export function rankActivity(
  turnState: LastEntryKind,
  mtime: number,
  now: number
): ActivityRank {
  const fresh = now - mtime <= ACTIVITY_FRESHNESS_MS;
  return {
    mtime,
    activity: fresh ? (ACTIVITY_SCORE[turnState] ?? 0) : 0,
    isHot: now - mtime <= HOT_RECENCY_MS,
  };
}

/** Positive when `a` outranks `b`, negative when `b` outranks `a`,
 * zero on a full tie: hot recency first, then activity, then mtime. */
export function compareActivity(a: ActivityRank, b: ActivityRank): number {
  if (a.isHot !== b.isHot) return a.isHot ? 1 : -1;
  if (a.activity !== b.activity) return a.activity - b.activity;
  return a.mtime - b.mtime;
}
