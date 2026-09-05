/**
 * The timers behind the turn monitor: the rollout poll interval, the
 * absolute hard cap, the phase-0 "Codex never activated" window, and
 * the re-armable stall timer. Owning the handles here keeps
 * `turnMonitor.ts` about what counts as progress rather than about
 * clearing four handles in the right order.
 */

type Timeout = ReturnType<typeof setTimeout>;

export class TurnMonitorTimers {
  private poll: ReturnType<typeof setInterval> | null = null;
  private hardCap: Timeout | null = null;
  private phase0: Timeout | null = null;
  private stall: Timeout | null = null;

  startPolling(intervalMs: number, tick: () => void): void {
    this.poll = setInterval(tick, intervalMs);
  }

  armHardCap(ms: number, onFire: () => void): void {
    this.hardCap = setTimeout(() => {
      this.hardCap = null;
      onFire();
    }, ms);
  }

  armPhase0(ms: number, onFire: () => void): void {
    this.phase0 = setTimeout(() => {
      this.phase0 = null;
      onFire();
    }, ms);
  }

  /** Replaces any pending stall timer, so every progress observation
   * pushes the cut time forward. */
  armStall(ms: number, onFire: () => void): void {
    this.clearStall();
    this.stall = setTimeout(() => {
      this.stall = null;
      onFire();
    }, ms);
  }

  clearStall(): void {
    if (this.stall) {
      clearTimeout(this.stall);
      this.stall = null;
    }
  }

  /** Idempotent. Called at turn end regardless of outcome. */
  clearAll(): void {
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    if (this.hardCap) {
      clearTimeout(this.hardCap);
      this.hardCap = null;
    }
    if (this.phase0) {
      clearTimeout(this.phase0);
      this.phase0 = null;
    }
    this.clearStall();
  }
}
