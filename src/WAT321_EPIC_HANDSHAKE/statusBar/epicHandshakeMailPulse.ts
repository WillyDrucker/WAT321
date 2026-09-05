/**
 * Mail pulse for the Epic Handshake widget. A late reply waiting in
 * the inbox shows as a mail glyph that pulses on arrival and again,
 * up to a cap, each time the user finishes a Claude turn, so the
 * reminder recurs without nagging. The glyph stays visible for a
 * bounded window, then the widget reads idle while the envelope
 * stays on disk for the dispatcher's TTL or the next prompt.
 */

const MAIL_PULSE_CAP = 3;
const MAIL_PULSE_DURATION_MS = 3_000;
const MAIL_VISIBLE_WINDOW_MS = 5 * 60 * 1_000;

export class MailPulse {
  private arrivedAt: number | null = null;
  private pulseCount = 0;
  private pulseStartedAt: number | null = null;

  /** Inbox emptied (consumed by a prompt or retrieved manually), so
   * the next arrival starts again at pulse 1. */
  reset(): void {
    this.arrivedAt = null;
    this.pulseCount = 0;
    this.pulseStartedAt = null;
  }

  /** Claude finished a turn while mail is pending: one more pulse,
   * up to the cap. Rapid consecutive events never double-count
   * because a new pulse waits for the previous window to close. */
  onClaudeResponseComplete(now: number): void {
    if (this.arrivedAt === null) return;
    if (now - this.arrivedAt > MAIL_VISIBLE_WINDOW_MS) return;
    if (this.pulseCount >= MAIL_PULSE_CAP) return;
    if (
      this.pulseStartedAt !== null &&
      now - this.pulseStartedAt < MAIL_PULSE_DURATION_MS
    ) {
      return;
    }
    this.pulseStartedAt = now;
    this.pulseCount++;
  }

  /** Glyph while the inbox holds mail. A newer arrival (younger
   * newest envelope) restarts the pulse state so the user sees the
   * initial pulse plus the follow-ups on the new mail rather than
   * the stale counter from whatever cleared just before. */
  glyph(now: number, newestAgeMs: number | null, oneHz: boolean): string {
    const arrivedAt = newestAgeMs !== null ? now - newestAgeMs : now;
    if (this.arrivedAt === null || arrivedAt > this.arrivedAt) {
      this.arrivedAt = arrivedAt;
      this.pulseCount = 1;
      this.pulseStartedAt = arrivedAt;
    }
    if (now - this.arrivedAt > MAIL_VISIBLE_WINDOW_MS) {
      return "$(wat321-epic-handshake)";
    }
    const inPulseWindow =
      this.pulseStartedAt !== null &&
      now - this.pulseStartedAt < MAIL_PULSE_DURATION_MS;
    return inPulseWindow && oneHz ? "$(mail-read)" : "$(mail)";
  }
}
