import type { NonActiveCompletion } from "../../engine/sessionResponseBridge";

/**
 * Tracks done-transitions on non-active workspace sessions so the
 * notification bridge can fire a completion for a session other than
 * the ranker-picked active one. Provider-generic over the candidate
 * shape: the caller supplies how to key a candidate, read its turn
 * state and mtime, and build the completion payload. Claude keys by
 * sessionId (30s fresh window), Codex keys by rollout path (120s).
 *
 * Contract: call `observe` every poll with the full candidate list and
 * the active key. A candidate that flips to `assistant-done` while
 * fresh and non-active is queued once (per-key reportedAsDone gate) -
 * `drain` hands the queue to the bridge and clears it. The active
 * candidate is tracked so a later ranking flip inherits a real
 * baseline, but never queued - the bridge's main path owns it.
 */

interface TrackedState {
  turnState: string;
  mtime: number;
  reportedAsDone: boolean;
}

interface NonActiveCompletionTrackerConfig<C> {
  /** Done-transition only counts when the candidate's mtime is within
   * this window, so a session that was already done before this process
   * started does not fire on first observation. Exceeds the rescan
   * cadence so a session completing just after a rescan still lands
   * inside the gate on the next one. */
  freshWindowMs: number;
  keyOf: (candidate: C) => string;
  turnStateOf: (candidate: C) => string;
  mtimeOf: (candidate: C) => number;
  /** Build the completion payload for a freshly-done non-active
   * candidate. Called only at the moment of the done-transition. */
  buildCompletion: (candidate: C, now: number) => NonActiveCompletion;
}

export class NonActiveCompletionTracker<C> {
  private readonly states = new Map<string, TrackedState>();
  private pending: NonActiveCompletion[] = [];

  constructor(private readonly config: NonActiveCompletionTrackerConfig<C>) {}

  /** Fold this poll's candidate walk into the tracker, queuing a
   * completion for any non-active candidate that just transitioned to
   * done while fresh. Drops keys no longer present in the walk. */
  observe(candidates: readonly C[], activeKey: string | null, now: number): void {
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = this.config.keyOf(candidate);
      seen.add(key);
      const turnState = this.config.turnStateOf(candidate);
      const mtime = this.config.mtimeOf(candidate);
      const isDone = turnState === "assistant-done";
      const prev = this.states.get(key);

      // Active session: track state for a future ranking flip, never
      // queue. First read of an unknown session: record without queuing.
      if (key === activeKey || prev === undefined) {
        this.states.set(key, { turnState, mtime, reportedAsDone: isDone });
        continue;
      }

      const isFresh = now - mtime <= this.config.freshWindowMs;
      const transitionedToDone = isDone && !prev.reportedAsDone;
      if (transitionedToDone && isFresh) {
        this.pending.push(this.config.buildCompletion(candidate, now));
      }
      this.states.set(key, {
        turnState,
        mtime,
        reportedAsDone: isDone || (prev.reportedAsDone && mtime === prev.mtime),
      });
    }
    for (const key of this.states.keys()) {
      if (!seen.has(key)) this.states.delete(key);
    }
  }

  /** Drain queued completions since the last call. */
  drain(): NonActiveCompletion[] {
    if (this.pending.length === 0) return [];
    const out = this.pending;
    this.pending = [];
    return out;
  }

  reset(): void {
    this.states.clear();
    this.pending = [];
  }
}
