/**
 * Tiny 60-second ticker used by both usage services during rate-limit
 * backoff so the widget's countdown ("Retry in 14:03") keeps ticking
 * without a full poll cycle. The ticker stops itself automatically
 * when the service leaves the rate-limited state, so the caller only
 * needs to remember to `start()` on entry and `stop()` on dispose.
 */

const DEFAULT_TICK_MS = 60_000;

export class CountdownTicker {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onTick: () => void,
    private readonly isRateLimited: () => boolean,
    private readonly tickMs: number = DEFAULT_TICK_MS
  ) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      if (this.isRateLimited()) {
        this.onTick();
      } else {
        this.stop();
      }
    }, this.tickMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
