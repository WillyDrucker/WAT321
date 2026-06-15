/**
 * Display refresh throttle for the visible TPS suffix on session-token
 * widgets.
 *
 * The underlying tps value updates as fast as the transcript writes
 * (sub-second during streaming on Claude and Codex). Rendering every
 * change makes the "NNtps" string
 * flicker rapidly. This class caches the displayed value and refreshes
 * it on a flat 1-second cadence so the visible number ticks at a
 * comfortable readable pace independent of the underlying signal rate.
 *
 * Per-widget state - each widget instance owns its own throttle so the
 * Claude widget's cadence does not drag the Codex widget's with it.
 * Reset on session change so a fresh session's first reading appears
 * immediately rather than waiting out the prior session's interval.
 */

const REFRESH_INTERVAL_MS = 1_000;

export class TpsThrottle {
  private lastUpdateMs = 0;
  private displayedTps: number | null | undefined = undefined;

  /** Return the value the widget should display right now. Pass the
   * latest raw tps reading from cached state on each render. Inside
   * the refresh interval the cached displayed value is returned -
   * once the interval elapses, the displayed value snaps to the
   * latest reading. */
  next(currentTps: number | null | undefined): number | null | undefined {
    const now = Date.now();
    if (now - this.lastUpdateMs >= REFRESH_INTERVAL_MS) {
      this.displayedTps = currentTps;
      this.lastUpdateMs = now;
    }
    return this.displayedTps;
  }

  /** Drop cached state so the next call snaps to the new reading
   * immediately. Call on session change. */
  reset(): void {
    this.lastUpdateMs = 0;
    this.displayedTps = undefined;
  }
}
