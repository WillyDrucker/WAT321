/**
 * Smoothed tokens-per-second for OpenCode and Local dispatches,
 * mirroring the windowed math in `src/shared/sessionTokens/tpsTracker.ts`
 * so these dispatches read in the same magnitude as Claude and Codex.
 *
 * Idle gaps reset the window (a tool-wait pause would otherwise smear
 * the rate). A minimum window age and token delta stop the first
 * sample pair from spiking on the first SSE chunk, and the 2s window
 * threshold matches the 2s poll so a 4-6 second dispatch reports a
 * real rate before completing. `lastObservedTokens` survives the
 * idle-gap clear and backs the unchanged-tokens guard, so a stale
 * sample after a clear cannot become a fresh baseline. The first sample
 * after a start or a clear is consumed as the baseline anchor
 * (`awaitingBaseline`), never entering `samples`: without it the first
 * window would measure from the tokens already accumulated before
 * watching began and cap at 999/s. The rollback branch leaves the flag
 * clear because `lastObservedTokens = totalTokens` already pins the
 * post-compact floor.
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
