import { existsSync } from "fs";
import { DISCOVERY_BACKOFF } from "./constants";

/**
 * Polls for the existence of a provider CLI directory using the exponential
 * backoff defined in constants.ts. Used by services that are enabled but
 * whose CLI may not be installed yet. When the directory appears, calls
 * onFound() once and stops polling until re-started.
 *
 * Backoff: 60s for the first 5 minutes, 5 min up to 30 minutes, then 15
 * min indefinitely. This catches quick installs without hammering the
 * filesystem for users who will never install.
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
