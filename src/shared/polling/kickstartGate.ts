import {
  KICKSTART_ACTIVITY_WINDOW_MS,
  KICKSTART_ESCALATION_MS,
} from "./constants";

/**
 * Activity-driven kickstart gate for the usage polling service.
 * Decides when a rate-limited service should wake up early because
 * the user is actively working (fresh transcript activity detected).
 *
 * Owns the escalation state: each failed kickstart round (all
 * post-wake strikes exhausted without a successful fetch) increases
 * the minimum park time before the next kickstart is allowed. After
 * enough failures, the gate effectively disables itself and lets the
 * natural rate-limit backoff timer drive retries.
 *
 * The gate resets on any successful fetch or on a manual reset
 * (e.g. Reset WAT321 command).
 */
export class KickstartGate {
  private consecutiveFailedKickstarts = 0;
  private postWakeStrikesRemaining = 0;
  private getActivityMs: (() => number | null) | null = null;

  /** Wire the activity probe (session token service's last mtime). */
  setActivityProbe(probe: () => number | null): void {
    this.getActivityMs = probe;
  }

  /** Should the service wake from rate-limited park right now? */
  shouldKickstart(now: number, rateLimitedAt: number): boolean {
    const step = Math.min(
      this.consecutiveFailedKickstarts,
      KICKSTART_ESCALATION_MS.length - 1
    );
    const minPark = KICKSTART_ESCALATION_MS[step];
    if (now - rateLimitedAt < minPark) return false;
    const activityMs = this.getActivityMs?.() ?? null;
    if (activityMs === null) return false;
    return now - activityMs <= KICKSTART_ACTIVITY_WINDOW_MS;
  }

  /** Called when a kickstart wake begins. Arms the post-wake strike
   * counter so the service gets a few quick retries before escalating. */
  onWake(): void {
    this.postWakeStrikesRemaining = 3;
  }

  /** Called on each 429 during post-wake strikes. Returns true if
   * strikes remain (keep retrying at normal cadence). Returns false
   * when strikes are exhausted (escalate and re-park). */
  consumeStrike(): boolean {
    if (this.postWakeStrikesRemaining <= 0) return false;
    this.postWakeStrikesRemaining--;
    if (this.postWakeStrikesRemaining > 0) return true;
    // Strikes exhausted - record the failed kickstart round.
    this.consecutiveFailedKickstarts = Math.min(
      this.consecutiveFailedKickstarts + 1,
      KICKSTART_ESCALATION_MS.length - 1
    );
    return false;
  }

  /** Clear post-wake strikes (called on successful fetch). */
  clearStrikes(): void {
    this.postWakeStrikesRemaining = 0;
  }

  /** Reset all escalation state. Called on successful fetch or
   * manual reset (Reset WAT321 command). */
  reset(): void {
    this.consecutiveFailedKickstarts = 0;
    this.postWakeStrikesRemaining = 0;
  }

  /** Diagnostic snapshot for the health command. Display only. */
  getDiagnostics(): { consecutiveFailedKickstarts: number; postWakeStrikesRemaining: number } {
    return {
      consecutiveFailedKickstarts: this.consecutiveFailedKickstarts,
      postWakeStrikesRemaining: this.postWakeStrikesRemaining,
    };
  }
}
