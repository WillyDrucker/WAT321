import { existsSync } from "node:fs";
import { DISCOVERY_BACKOFF } from "./pollingTimings";

/**
 * Polls for a provider CLI directory on the `DISCOVERY_BACKOFF`
 * schedule, for services that are enabled before their CLI is
 * installed. The schedule catches a quick install without hammering the
 * filesystem. When the directory appears, calls onFound() once and stops.
 */
export class DiscoveryPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private disposed = false;

  constructor(
    private readonly authDir: string,
    private readonly onFound: () => void
  ) {}

  /** Begin polling. No-op if already disposed. */
  start(): void {
    if (this.disposed) return;
    if (this.startedAt === 0) this.startedAt = Date.now();
    this.scheduleTick();
  }

  /** Stop polling without disposing. Can be re-started. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Stop polling permanently. */
  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private scheduleTick(): void {
    const elapsed = Date.now() - this.startedAt;
    const step =
      DISCOVERY_BACKOFF.find((s) => elapsed < s.untilMs) ??
      DISCOVERY_BACKOFF[DISCOVERY_BACKOFF.length - 1];

    this.timer = setTimeout(() => {
      if (this.disposed) return;
      if (existsSync(this.authDir)) {
        this.stop();
        this.startedAt = 0;
        this.onFound();
        return;
      }
      this.scheduleTick();
    }, step.intervalMs);
  }
}
