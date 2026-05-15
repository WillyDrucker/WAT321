/**
 * Smoothed tokens-per-second tracker shared by Claude and Codex
 * session-token services. Cumulative-count samples at transcript-mtime
 * instants in; stable rate reflecting only active write periods out.
 * Mtime time axis, minimum window age, idle-gap reset, and
 * baseline-anchor design all documented in `WAT321_MEMORY_EXTENDED.md`.
 */

const TPS_MAX = 999;
const WINDOW_MS = 60_000;
const IDLE_GAP_MS = 10_000;
/** Window must span at least this many ms of mtime before a rate is
 * computable. The very first sample-pair after a session starts captures
 * a step function (cache-creation tokens roll in all at once); waiting a
 * couple of seconds lets that spike smooth out before a number reaches
 * the widget. 2s is the sweet spot - long enough to skip past the
 * cache-creation pair, short enough that the user sees TPS appear
 * within a few seconds of an active turn instead of staring at a blank
 * suffix for 5+ seconds while wondering if the feature is broken. */
const MIN_WINDOW_AGE_MS = 2_000;
const MIN_TOKEN_DELTA = 5;

interface Sample {
  atMs: number;
  tokens: number;
}

export class TpsTracker {
  private prevSessionId: string | null = null;
  private lastValue: number | null = null;
  private samples: Sample[] = [];
  /** Durable record of the most recently observed token count. Survives
   * idle-gap clears so the unchanged-tokens guard can reject a stale
   * sample even when `samples` was just emptied. Without this, an idle
   * clear on call N followed by a stale-token sample on call N+1 would
   * push the stale value as a new baseline (samples is empty so `last`
   * is undefined; the guard's `last !== undefined` short-circuits) and
   * the next real sample would average against an artificially-old
   * timestamp, sagging the rate. */
  private lastObservedTokens: number | null = null;
  /** True when the next observed sample should be consumed as a
   * baseline anchor (updates `lastObservedTokens`, does not enter
   * `samples`). Set on construction, on session change, and after an
   * idle-gap clear. Cleared once a baseline has been recorded so
   * subsequent samples accumulate normally. */
  private awaitingBaseline = true;
  /** Wall-clock millisecond timestamp of the last NEW (different-
   * tokens) sample. Used to clear `lastValue` after `IDLE_GAP_MS` of
   * wall-clock silence even when transcript mtime stops advancing -
   * which is exactly what happens after a Codex turn completes or
   * stalls in a tool call. Without this the unchanged-tokens guard
   * returns the previous `lastValue` on every poll forever, pinning
   * a stale spike on the widget long after generation has stopped. */
  private lastSampleWallMs = 0;

  /** Add a new cumulative-token sample at the given mtime instant.
   * Returns the smoothed rate, or `null` when there is not yet enough
   * activity to compute one. The previous value is held during pauses
   * and below-threshold windows so the tooltip stays steady. */
  add(sessionId: string, atMs: number, tokens: number): number | null {
    if (sessionId !== this.prevSessionId) {
      this.prevSessionId = sessionId;
      this.lastValue = null;
      this.samples = [];
      this.lastObservedTokens = null;
      this.awaitingBaseline = true;
      this.lastSampleWallMs = 0;
    }

    // Wall-clock idle clear runs BEFORE the unchanged-tokens guard so
    // a post-turn poll where tokens have not changed in IDLE_GAP_MS of
    // real time wipes `lastValue` instead of pinning the prior in-
    // flight spike. Transcript mtime stops advancing once Codex
    // finishes writing token_count events, so the mtime-based gap
    // below cannot trigger on its own here.
    const nowWall = Date.now();
    if (
      this.lastSampleWallMs > 0 &&
      nowWall - this.lastSampleWallMs > IDLE_GAP_MS
    ) {
      this.samples = [];
      this.lastValue = null;
      this.awaitingBaseline = true;
    }

    const last = this.samples[this.samples.length - 1];

    if (this.lastObservedTokens !== null && tokens < this.lastObservedTokens) {
      // Rollback (compaction reset). Clear `lastValue` too so the
      // widget does not keep showing the pre-reset rate until the new
      // window ages in - that reads as ghost activity on a session
      // that just shed tokens. `lastObservedTokens = tokens` is
      // already the post-rollback anchor; the next sample with new
      // tokens IS a real delta so awaitingBaseline stays cleared.
      this.samples = [];
      this.lastValue = null;
      this.lastObservedTokens = tokens;
    } else if (last !== undefined && atMs - last.atMs > IDLE_GAP_MS) {
      // Idle gap on the mtime axis. Keep `lastValue` so the tooltip
      // shows the most recent valid rate during a tool wait or
      // between-prompt pause instead of going blank.
      // `lastObservedTokens` survives the clear so the next call still
      // gates against the durable marker even though `samples` is
      // empty. Re-arm baseline so the first sample after the gap
      // anchors the next window instead of seeding it with a multi-
      // thousand-token jump accumulated during the pause.
      this.samples = [];
      this.awaitingBaseline = true;
    }

    // Unchanged-tokens guard reads the durable `lastObservedTokens`,
    // not the (possibly-cleared) sample window. The transcript can
    // tick mtime for non-token-bearing writes (tool result bodies,
    // sidecar entries), so we sample only when tokens strictly
    // increase from the last observed value.
    if (this.lastObservedTokens !== null && tokens === this.lastObservedTokens) {
      return this.lastValue;
    }

    // From here the sample is genuinely new - record wall-clock time
    // for the next poll's idle check.
    this.lastSampleWallMs = nowWall;

    if (this.awaitingBaseline) {
      // Baseline anchor: record the cumulative token count we started
      // watching at, but do not push into `samples`. The NEXT sample
      // becomes `samples[0]`, so the first computable window measures
      // only the increment that arrived after we started watching.
      this.lastObservedTokens = tokens;
      this.awaitingBaseline = false;
      return this.lastValue;
    }

    this.samples.push({ atMs, tokens });
    this.lastObservedTokens = tokens;
    const cutoff = atMs - WINDOW_MS;
    while (this.samples.length > 1 && this.samples[0].atMs < cutoff) {
      this.samples.shift();
    }

    if (this.samples.length < 2) return this.lastValue;

    const oldest = this.samples[0];
    const newest = this.samples[this.samples.length - 1];
    const tokenDelta = newest.tokens - oldest.tokens;
    const timeDeltaMs = newest.atMs - oldest.atMs;

    if (timeDeltaMs < MIN_WINDOW_AGE_MS) return this.lastValue;
    if (tokenDelta < MIN_TOKEN_DELTA) return this.lastValue;

    this.lastValue = Math.min(TPS_MAX, (tokenDelta / timeDeltaMs) * 1000);
    return this.lastValue;
  }

  reset(): void {
    this.prevSessionId = null;
    this.lastValue = null;
    this.samples = [];
    this.lastObservedTokens = null;
    this.awaitingBaseline = true;
    this.lastSampleWallMs = 0;
  }
}
