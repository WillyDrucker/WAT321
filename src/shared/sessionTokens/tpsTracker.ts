/**
 * Smoothed tokens-per-second tracker shared by Claude and Codex
 * session-token services. Each provider feeds in cumulative token
 * counts at transcript-mtime instants; the tracker reports a stable
 * rate that reflects only periods of actual write activity.
 *
 * Why mtime instead of Date.now() as the time axis: mtime advances
 * only when the transcript is written. Long idle stretches (user
 * thinking, tool waits, between-prompt pauses) leave mtime frozen so
 * they contribute zero seconds to the denominator instead of dragging
 * the rate toward zero.
 *
 * Why a minimum window age: the very first sample-pair after a session
 * starts captures a step function (cache-creation tokens roll in all
 * at once) which produces nonsense rates capped at TPS_MAX. Holding
 * the previous value until the window spans at least
 * `MIN_WINDOW_AGE_MS` of mtime lets that spike smooth out before any
 * number reaches the widget.
 *
 * Why an idle-gap reset: if the gap since the last accepted sample
 * exceeds `IDLE_GAP_MS`, we treat the window as stale and re-anchor
 * from the new sample. Without this, the first active sample after a
 * 5-minute pause averages thousands of new tokens against tens of
 * milliseconds of new mtime span, blowing the rate up. The cached
 * `lastValue` survives the reset so the widget keeps showing the most
 * recent valid rate during the pause.
 */

const TPS_MAX = 999;
const WINDOW_MS = 60_000;
const IDLE_GAP_MS = 10_000;
const MIN_WINDOW_AGE_MS = 5_000;
const MIN_TOKEN_DELTA = 5;

interface Sample {
  atMs: number;
  tokens: number;
}

export class TpsTracker {
  private prevSessionId: string | null = null;
  private lastValue: number | null = null;
  private samples: Sample[] = [];

  /** Add a new cumulative-token sample at the given mtime instant.
   * Returns the smoothed rate, or `null` when there is not yet enough
   * activity to compute one. The previous value is held during pauses
   * and below-threshold windows so the tooltip stays steady. */
  add(sessionId: string, atMs: number, tokens: number): number | null {
    if (sessionId !== this.prevSessionId) {
      this.prevSessionId = sessionId;
      this.lastValue = null;
      this.samples = [];
    }

    const last = this.samples[this.samples.length - 1];

    if (last !== undefined && tokens < last.tokens) {
      // Rollback (compaction reset). Clear `lastValue` too so the
      // widget does not keep showing the pre-reset rate until the new
      // window ages in - that reads as ghost activity on a session
      // that just shed tokens.
      this.samples = [];
      this.lastValue = null;
    } else if (last !== undefined && atMs - last.atMs > IDLE_GAP_MS) {
      // Idle gap. Keep `lastValue` so the tooltip shows the most
      // recent valid rate during a tool wait or between-prompt pause
      // instead of going blank.
      this.samples = [];
    } else if (last !== undefined && atMs === last.atMs && tokens === last.tokens) {
      return this.lastValue;
    }

    this.samples.push({ atMs, tokens });
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
  }
}
