/**
 * Smoothed tokens-per-second for OpenCode and Local dispatches.
 * Mirrors the windowed math in `src/shared/sessionTokens/tpsTracker.ts`
 * so these dispatches read in the same magnitude as Claude/Codex.
 *
 * Idle gaps reset the window (a tool-wait pause would otherwise smear
 * the rate). Min window age + min token delta block the first
 * sample-pair from spiking when the first SSE chunk lands. The window
 * threshold (2s) matches the 2s poll cadence so a short bridge
 * dispatch (4-6 seconds is common) reports a real rate before
 * completing instead of staying at 0/s.
 *
 * `lastObservedTokens` is durable across the idle-gap clear: the
 * unchanged-tokens guard reads this marker, not `samples`. Without
 * it, a stale-token sample arriving after an idle clear would push
 * the stale value as a fresh baseline and the next real sample would
 * average against an artificially-old timestamp.
 *
 * `awaitingBaseline` mirrors the TS tracker: the first sample after a
 * session start or idle-gap clear is consumed as a baseline anchor
 * (updates `lastObservedTokens`, does not enter `samples`). The
 * rollback branch leaves `awaitingBaseline` cleared because
 * `lastObservedTokens = totalTokens` already pins the post-compact
 * floor, so the next sample with new tokens enters the window
 * directly. Without the baseline anchor, the first computable window
 * measures from "tokens already accumulated when we started watching"
 * to "tokens after first new chunk", which on a first turn caps the
 * rate at 999/s.
 */

const TPS_MAX = 999;
const TPS_WINDOW_MS = 60_000;
const TPS_IDLE_GAP_MS = 10_000;
const TPS_MIN_WINDOW_AGE_MS = 2_000;
const TPS_MIN_TOKEN_DELTA = 2;

export function makeTpsComputer() {
  const samples = [];
  let lastValue = 0;
  let lastObservedTokens = null;
  let awaitingBaseline = true;
  // Wall-clock millis of the last NEW (different-tokens) sample. Lets
  // the unchanged-tokens path clear `lastValue` after TPS_IDLE_GAP_MS
  // of real-time silence. The bridge's char-progress events stop
  // arriving when a turn ends, so without this the tooltip pins the
  // last in-flight rate forever.
  let lastSampleWallMs = 0;

  return (atMs, totalTokens) => {
    const nowWall = Date.now();
    if (lastSampleWallMs > 0 && nowWall - lastSampleWallMs > TPS_IDLE_GAP_MS) {
      samples.length = 0;
      lastValue = 0;
      awaitingBaseline = true;
    }
    const last = samples[samples.length - 1];
    if (lastObservedTokens !== null && totalTokens < lastObservedTokens) {
      // Rollback path. lastObservedTokens=totalTokens is the post-
      // rollback anchor, and awaitingBaseline stays cleared so the next
      // sample with new tokens enters the window directly.
      samples.length = 0;
      lastValue = 0;
      lastObservedTokens = totalTokens;
    } else if (last !== undefined && atMs - last.atMs > TPS_IDLE_GAP_MS) {
      samples.length = 0;
      awaitingBaseline = true;
    }
    if (lastObservedTokens !== null && totalTokens === lastObservedTokens) {
      return lastValue;
    }
    lastSampleWallMs = nowWall;
    if (awaitingBaseline) {
      lastObservedTokens = totalTokens;
      awaitingBaseline = false;
      return lastValue;
    }
    samples.push({ atMs, tokens: totalTokens });
    lastObservedTokens = totalTokens;
    const cutoff = atMs - TPS_WINDOW_MS;
    while (samples.length > 1 && samples[0].atMs < cutoff) {
      samples.shift();
    }
    if (samples.length < 2) return lastValue;
    const oldest = samples[0];
    const newest = samples[samples.length - 1];
    const tokenDelta = newest.tokens - oldest.tokens;
    const timeDeltaMs = newest.atMs - oldest.atMs;
    if (timeDeltaMs < TPS_MIN_WINDOW_AGE_MS) return lastValue;
    if (tokenDelta < TPS_MIN_TOKEN_DELTA) return lastValue;
    lastValue = Math.min(TPS_MAX, (tokenDelta / timeDeltaMs) * 1000);
    return lastValue;
  };
}
