import { DiscoveryPoller } from "./discovery";
import { POLL_INTERVAL_MS } from "./pollingTimings";
import {
  startRecoveryWatchdog,
  type RecoveryWatchdog,
  type RecoveryWatchdogDeps,
} from "./usageServiceRecoveryWatchdog";

/**
 * Every timer a usage service owns: the discovery poller that waits
 * for the auth dir, the startup delay, the poll interval, one-shot
 * retries, and the recovery watchdog. `UsageServiceBase` decides what
 * a tick does and this class decides when ticks happen, so disposing
 * the service is one call that cannot leak a handle.
 */
export class UsagePollSchedule {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private recoveryWatchdog: RecoveryWatchdog | null = null;
  private discoveryPoller: DiscoveryPoller | null = null;
  private pollIntervalMs = POLL_INTERVAL_MS;
  private disposed = false;

  constructor(private readonly tick: () => void) {}

  /** Active poll cadence in ms. Stamped onto transition records so a
   * reader can tell the normal cadence apart from a rate-limit
   * backoff stretch. */
  getPollIntervalMs(): number {
    return this.pollIntervalMs;
  }

  /** Watch for the auth dir to appear. `onFound` fires once. */
  startDiscovery(authDir: string, onFound: () => void): void {
    this.discoveryPoller?.dispose();
    this.discoveryPoller = new DiscoveryPoller(authDir, onFound);
    this.discoveryPoller.start();
  }

  /** First tick after `delayMs`, then every `POLL_INTERVAL_MS`. The
   * recovery watchdog is re-armed alongside so the discovery-recovered
   * path (auth dir appeared post-startup) also gets the 15-min
   * ceiling. Idempotent. */
  startPolling(delayMs: number, watchdog: RecoveryWatchdogDeps): void {
    this.discoveryPoller?.stop();
    this.schedule(() => {
      this.tick();
      this.stopPolling();
      this.timer = setInterval(this.tick, POLL_INTERVAL_MS);
    }, delayMs);
    this.recoveryWatchdog?.dispose();
    this.recoveryWatchdog = startRecoveryWatchdog(watchdog);
  }

  /** Replace the poll cadence and restart the interval on it. */
  setPollInterval(ms: number): void {
    this.stopPolling();
    this.timer = setInterval(this.tick, ms);
    this.pollIntervalMs = ms;
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One-shot callback, tracked so dispose can clear it. */
  schedule(fn: () => void, ms: number): void {
    if (this.disposed) return;
    const handle = setTimeout(() => {
      this.pendingTimers.delete(handle);
      if (this.disposed) return;
      fn();
    }, ms);
    this.pendingTimers.add(handle);
  }

  dispose(): void {
    this.disposed = true;
    this.stopPolling();
    this.recoveryWatchdog?.dispose();
    this.recoveryWatchdog = null;
    for (const handle of this.pendingTimers) clearTimeout(handle);
    this.pendingTimers.clear();
    this.discoveryPoller?.dispose();
    this.discoveryPoller = null;
  }
}
