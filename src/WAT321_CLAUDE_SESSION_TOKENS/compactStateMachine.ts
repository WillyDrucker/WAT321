import type { LastEntryKind } from "../shared/transcriptClassifier";
import {
  parseLastManualCompactStart,
  parseRecentCompactBoundaries,
} from "./parsers";

/**
 * State machine driving the Claude session-token widget's compact-
 * progress display. Detects manual `/compact` from transcript
 * structure alone - no in-memory hooks into Claude Code.
 *
 * Inputs per sync():
 *   - The transcript tail (same string the rest of the parsers use)
 *   - The current resolved sessionId (state resets across sessions)
 *   - Wall-clock now (passed in for testability)
 *   - Classifier output from the same tail (gates activity recovery)
 *
 * State machine:
 *
 *   IDLE on /compact user entry observed transitions to IN_FLIGHT.
 *
 *   IN_FLIGHT exits silently on ANY of:
 *     1. new `compact_boundary` system entry  (clean canonical exit)
 *     2. classifier says anything other than  (activity recovery -
 *        "compact-end"                          missed the boundary,
 *                                              user moved on)
 *     3. 180s elapsed since start              (failsafe)
 *     4. sessionId changes                     (workspace switched)
 *
 * Every exit is silent: no toast, no log, no diagnostic surface
 * beyond the health command snapshot. The widget just returns to
 * normal token rendering. Per the user-track contract: the bar
 * existing or not existing IS the entire user-visible signal.
 *
 * Duration estimation:
 *   Rolling average of the last `HISTORICAL_WINDOW` durations parsed
 *   from compact_boundary entries in the tail. Falls back to
 *   `DEFAULT_DURATION_MS` (120s - deliberately on the high side so
 *   the bar tends to finish early rather than clamp at 99%) when
 *   the session has no boundary history yet. After the first compact
 *   in a session lands, the user's actual durations replace the
 *   default for subsequent bars.
 */

/** Failsafe ceiling. Past this without a boundary entry, treat the
 * compact as failed/lost and silently return to idle. Worst-case
 * compacts in field transcripts run 50-55s; 3x is a generous bound
 * that catches a stuck state machine without falsely exiting a real
 * long-running compact. */
const FAILSAFE_TIMEOUT_MS = 180_000;
/** Default duration when no historical boundaries are available yet.
 * 120s is deliberately above the typical 50-55s observed compact
 * duration so a fresh-session bar reaches at most ~45% before the
 * real compact ends and the widget returns to idle. Better to under-
 * fill than to clamp at 99% with significant time still elapsing. */
const DEFAULT_DURATION_MS = 120_000;
/** Width of the compact progress bar in cells. Matches the 5-cell
 * compact bar already used by the Claude usage widget in compact
 * display mode, so the visual rhythm is consistent. */
const COMPACT_BAR_WIDTH = 5;
/** How many recent compact durations to average. Three is enough to
 * smooth out a single outlier while still adapting to drift in this
 * user's conversation size. */
const HISTORICAL_WINDOW = 3;
/** Duration of the post-completion flash for auto-compacts. The
 * trigger:"auto" boundary lands without any prior in-flight signal -
 * the user gets no progress bar during the run because Claude Code
 * writes the user's triggering prompt AFTER the compact runs, not
 * before. A short flash on the boundary at least acknowledges that
 * an auto-compact just happened before the widget returns to the
 * normal post-compact token render. 1.5s reads as a deliberate beat
 * without overstaying its welcome. */
const AUTO_COMPACT_FLASH_MS = 1_500;

export interface CompactSnapshot {
  state: "idle" | "in-flight" | "flashing-completion";
  /** Wall-clock ms at which a `flashing-completion` window expires.
   * The widget renders from cached snapshot state between service polls
   * (15s cadence) but the ticker runs at 250ms. Exposing the expiry
   * timestamp lets the widget's render branch self-narrow back to
   * idle the moment the flash window passes, instead of holding the
   * orange skin for up to a full poll interval. Null when no flash
   * is armed. */
  flashUntil: number | null;
  /** Wall-clock timestamp the in-flight compact started, or null
   * when idle. Sourced from the /compact user entry's `timestamp`
   * field (not `Date.now()`), so the duration math stays accurate
   * even if there's transcript-write latency. */
  startedAt: number | null;
  /** Current best estimate of total compact duration in ms. Either
   * the rolling average of recent boundary durations or the 120s
   * default. */
  estimatedDurationMs: number;
  /** Wall-clock ms elapsed since `startedAt`. 0 when idle. */
  elapsedMs: number;
  /** Display percentage. 1-99 when in-flight, 99 during the auto-
   * compact completion flash (saturated final reading), 0 when idle.
   * Capped at 99 in every non-idle state to avoid status-bar width
   * shifts at the 100-mark. */
  percent: number;
  /** Number of filled cells in the 5-cell bar. In-flight rounds from
   * the ratio (0-5, with cell 5 lighting at ratio >= 0.9); flash uses
   * all 5 to read as "just completed"; idle = 0. */
  barsFilled: number;
}

export class CompactStateMachine {
  private startedAt: number | null = null;
  private lastBoundaryAt: number | null = null;
  private lastSeenSessionId: string | null = null;
  private recentDurationsMs: number[] = [];
  /** Wall-clock ms at which the auto-compact completion flash should
   * expire. Set when a new trigger:"auto" boundary lands and we were
   * NOT already in-flight (manual compacts don't get the flash - they
   * already had the in-flight bar showing progress). Null when no
   * flash is active. */
  private flashUntil: number | null = null;

  /** Compute the current snapshot from the latest tail. Idempotent:
   * calling sync() multiple times with the same inputs yields the
   * same snapshot. Side effects (state transitions, history append)
   * are gated on observable new data. */
  sync(args: {
    tail: string;
    sessionId: string;
    now: number;
    classifierKind: LastEntryKind;
  }): CompactSnapshot {
    const { tail, sessionId, now, classifierKind } = args;

    // Session change: reset all transient state and re-seed history
    // from the new session's tail. Old session's startedAt is meaningless
    // for the new session, and a different conversation may have
    // wildly different typical compact durations. Also adopt the newest
    // historical boundary's timestamp as `lastBoundaryAt` so a session
    // attach with a pre-existing auto-compact in the tail does NOT
    // trigger the completion flash for an event we never observed live.
    if (sessionId !== this.lastSeenSessionId) {
      this.startedAt = null;
      this.flashUntil = null;
      this.lastSeenSessionId = sessionId;
      const initial = parseRecentCompactBoundaries(tail, HISTORICAL_WINDOW);
      this.recentDurationsMs = initial.map((b) => b.durationMs);
      this.lastBoundaryAt =
        initial.length > 0 ? initial[initial.length - 1].at : null;
    }

    // Check for new compact_boundary - canonical clean exit. A newer
    // boundary than what we've already adopted means a compact just
    // completed. Append to rolling history and exit any in-flight state.
    //
    // Auto-compact completion flash: when the new boundary is
    // trigger:"auto" AND we were not tracking this compact as in-flight
    // (which is always the case for auto - the user's triggering prompt
    // lands AFTER the compact runs, so there's no observable start
    // signal), arm a short flash so the user sees acknowledgment that
    // an auto-compact just happened. Manual compacts already had the
    // in-flight bar showing - no flash needed there.
    const recent = parseRecentCompactBoundaries(tail, HISTORICAL_WINDOW);
    if (recent.length > 0) {
      const newest = recent[recent.length - 1];
      if (this.lastBoundaryAt === null || newest.at > this.lastBoundaryAt) {
        const wasInFlight = this.startedAt !== null;
        this.lastBoundaryAt = newest.at;
        this.recentDurationsMs.push(newest.durationMs);
        while (this.recentDurationsMs.length > HISTORICAL_WINDOW) {
          this.recentDurationsMs.shift();
        }
        this.startedAt = null;
        if (!wasInFlight && newest.trigger === "auto") {
          this.flashUntil = now + AUTO_COMPACT_FLASH_MS;
        }
      }
    }

    // Check for /compact start marker. Only adopt if strictly newer
    // than the last boundary we saw (otherwise it's the start marker
    // for an ALREADY-COMPLETED compact, not a new one). Clearing
    // `flashUntil` is required so a manual /compact landing during a
    // still-open auto-compact flash window does not let the old flash
    // bleed back through after the manual compact's own boundary lands
    // and resets `startedAt` to null.
    const startAt = parseLastManualCompactStart(tail);
    if (
      startAt !== null &&
      (this.lastBoundaryAt === null || startAt > this.lastBoundaryAt) &&
      startAt !== this.startedAt
    ) {
      this.startedAt = startAt;
      this.flashUntil = null;
    }

    // Failsafe: too long without a boundary entry, silently abandon.
    if (this.startedAt !== null && now - this.startedAt > FAILSAFE_TIMEOUT_MS) {
      this.startedAt = null;
    }

    // Activity recovery: the boundary entry never landed (file watcher
    // race, partial JSONL write, anything) but the user has moved on
    // to a normal turn. Classifier returns "compact-end" while the
    // last entry is still a compact marker; anything else means a
    // normal user/assistant turn is the tail. Silently exit.
    if (this.startedAt !== null && classifierKind !== "compact-end") {
      this.startedAt = null;
    }

    return this.buildSnapshot(now);
  }

  /** Drop all transient state. Called by service.reset() on the
   * Reset WAT321 command and when the underlying token service
   * disposes. */
  reset(): void {
    this.startedAt = null;
    this.lastBoundaryAt = null;
    this.lastSeenSessionId = null;
    this.recentDurationsMs = [];
    this.flashUntil = null;
  }

  /** Diagnostic snapshot for the health command. Read-only view of
   * the machine's internal state plus the rolling history that drives
   * estimates. */
  getDiagnostics(): {
    state: "idle" | "in-flight" | "flashing-completion";
    startedAt: number | null;
    estimatedDurationMs: number;
    recentDurationsMs: readonly number[];
  } {
    const now = Date.now();
    const flashActive = this.flashUntil !== null && now < this.flashUntil;
    let state: "idle" | "in-flight" | "flashing-completion";
    if (this.startedAt !== null) state = "in-flight";
    else if (flashActive) state = "flashing-completion";
    else state = "idle";
    return {
      state,
      startedAt: this.startedAt,
      estimatedDurationMs: this.estimateDuration(),
      recentDurationsMs: [...this.recentDurationsMs],
    };
  }

  private estimateDuration(): number {
    if (this.recentDurationsMs.length === 0) return DEFAULT_DURATION_MS;
    const sum = this.recentDurationsMs.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.recentDurationsMs.length);
  }

  private buildSnapshot(now: number): CompactSnapshot {
    // In-flight wins over flash: a fresh /compact starting right after
    // a previous auto-compact boundary should immediately show progress,
    // not the completion flash from the prior compact.
    if (this.startedAt !== null) {
      const elapsed = now - this.startedAt;
      const duration = this.estimateDuration();
      const ratio = Math.min(0.99, Math.max(0, elapsed / duration));
      const pct = ratio * 100;
      return {
        state: "in-flight",
        startedAt: this.startedAt,
        estimatedDurationMs: duration,
        elapsedMs: elapsed,
        // Floor for the displayed percent (so 0.4999 -> 49% not 50%)
        // and round for the bar fill count (matches Claude usage
        // rolling-bar thresholds: cells light at 10/30/50/70/90% so
        // the 5th cell only fills near completion). Capped at 99% to
        // keep the status bar width stable when reaching the boundary.
        percent: Math.max(1, Math.min(99, Math.floor(pct))),
        barsFilled: Math.min(
          COMPACT_BAR_WIDTH,
          Math.round((pct / 100) * COMPACT_BAR_WIDTH)
        ),
        flashUntil: null,
      };
    }
    // Auto-compact completion flash: bar saturated at 5/5 + 99%, same
    // visual rhythm as the end of an in-flight bar, held for the flash
    // window. Expires by falling through to idle on the next call.
    if (this.flashUntil !== null && now < this.flashUntil) {
      return {
        state: "flashing-completion",
        startedAt: null,
        estimatedDurationMs: this.estimateDuration(),
        elapsedMs: 0,
        percent: 99,
        barsFilled: COMPACT_BAR_WIDTH,
        flashUntil: this.flashUntil,
      };
    }
    if (this.flashUntil !== null && now >= this.flashUntil) {
      this.flashUntil = null;
    }
    return {
      state: "idle",
      startedAt: null,
      estimatedDurationMs: this.estimateDuration(),
      elapsedMs: 0,
      percent: 0,
      barsFilled: 0,
      flashUntil: null,
    };
  }
}

/** Width of the compact progress bar in cells. Exported for the
 * widget renderer so the bar layout stays in sync with the snapshot
 * math without duplicating the constant. */
export const COMPACT_BAR_CELL_COUNT = COMPACT_BAR_WIDTH;
