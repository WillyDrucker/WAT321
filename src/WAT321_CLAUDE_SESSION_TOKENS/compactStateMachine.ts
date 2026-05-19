import { parseRecentCompactBoundaries } from "./parsers";

/**
 * State machine driving the Claude session-token widget's compact-
 * progress display.
 *
 * Architecture constraint. Claude Code buffers the `<command-name>/
 * compact</command-name>` user entry until the compact completes;
 * auto-compact never writes any pre-completion entry at all. The only
 * observable signal we get from the transcript is the structured
 * `type:"system", subtype:"compact_boundary"` entry at the end of the
 * operation. Live in-flight detection would require touching
 * `~/.claude/` (PreCompact hook or plugin registration), which is
 * outside WAT321's "never write outside `~/.wat321/`" contract. So
 * the machine is end-only: on a fresh boundary entry, fire a brief
 * completion flash; otherwise idle.
 *
 * Two states:
 *
 *   IDLE on new `compact_boundary` entry transitions to
 *   FLASHING_COMPLETION for 1.5s (auto) or 2.5s (manual). The longer
 *   manual window reflects that the user is actively watching for
 *   acknowledgment after typing `/compact`; auto-compact lands
 *   without warning and a shorter beat is enough.
 *
 *   FLASHING_COMPLETION transitions back to IDLE the moment
 *   `Date.now() >= flashUntil`. The widget consults this timestamp
 *   on every ticker frame so the skin collapses cleanly between
 *   service polls.
 *
 * Session-attach behavior. On sessionId change the machine adopts
 * the newest historical boundary's timestamp into `lastBoundaryAt`
 * so a session whose tail already contains a compact does NOT fire
 * the flash for an event we never observed live. Rolling 3-compact
 * duration history is also re-seeded from the tail for the health
 * command's "typical duration" diagnostic.
 *
 * Every transition is silent: no toast, no log, no surface beyond
 * the health command snapshot.
 */

/** Default duration estimate used by the health command's "next
 * compact estimate" line when no history is available yet. 120s sits
 * on the high side of typical manual compacts (~50s) and auto-
 * compacts (~120s). */
const DEFAULT_DURATION_MS = 120_000;
/** Width of the compact flash bar in cells. Five cells matches the
 * Claude usage widget's compact-mode bar so the visual rhythm is
 * consistent. Flash always renders all five filled. */
const COMPACT_BAR_WIDTH = 5;
/** How many recent compact durations to average for the health
 * command's diagnostic. */
const HISTORICAL_WINDOW = 3;
/** Flash duration for trigger:"auto" boundaries. Auto-compact lands
 * without warning - a brief beat is enough acknowledgment. */
const AUTO_COMPACT_FLASH_MS = 1_500;
/** Flash duration for trigger:"manual" boundaries. Manual is user-
 * typed; they're actively watching, so we hold the flash a little
 * longer to give them clear visual confirmation. */
const MANUAL_COMPACT_FLASH_MS = 2_500;

export interface CompactSnapshot {
  state: "idle" | "flashing-completion";
  /** Current best estimate of total compact duration in ms. Either
   * the rolling average of recent boundary durations or the 120s
   * default. Read-only diagnostic surface for the health command;
   * has no visual effect on the widget itself. */
  estimatedDurationMs: number;
  /** Display percentage. 100 during flash (saturated final reading),
   * 0 when idle. */
  percent: number;
  /** Number of filled cells in the 5-cell bar. Flash uses all 5 to
   * read as "just completed"; idle = 0. */
  barsFilled: number;
  /** Wall-clock ms at which a `flashing-completion` window expires.
   * The widget consults this on every ticker frame so the flash
   * collapses back to normal token rendering the instant the window
   * passes. Null outside the flash state. */
  flashUntil: number | null;
}

export class CompactStateMachine {
  private lastBoundaryAt: number | null = null;
  private lastSeenSessionId: string | null = null;
  private recentDurationsMs: number[] = [];
  private flashUntil: number | null = null;

  /** Compute the current snapshot from the latest tail. Idempotent:
   * calling sync() multiple times with the same inputs yields the
   * same snapshot. */
  sync(args: { tail: string; sessionId: string; now: number }): CompactSnapshot {
    const { tail, sessionId, now } = args;

    // Session change: reset flash, re-seed history from the new
    // session's tail, adopt the newest historical boundary's
    // timestamp so a session attach whose tail already contains a
    // compact does NOT trigger the flash for an event we never
    // observed live.
    if (sessionId !== this.lastSeenSessionId) {
      this.flashUntil = null;
      this.lastSeenSessionId = sessionId;
      const initial = parseRecentCompactBoundaries(tail, HISTORICAL_WINDOW);
      this.recentDurationsMs = initial.map((b) => b.durationMs);
      this.lastBoundaryAt =
        initial.length > 0 ? initial[initial.length - 1].at : null;
    }

    // Boundary detection - canonical end signal. A newer boundary
    // than what we've adopted means a compact just completed. Append
    // to rolling history and arm the completion flash. Manual gets a
    // longer hold than auto since the user is actively watching
    // after typing /compact.
    const recent = parseRecentCompactBoundaries(tail, HISTORICAL_WINDOW);
    if (recent.length > 0) {
      const newest = recent[recent.length - 1];
      if (this.lastBoundaryAt === null || newest.at > this.lastBoundaryAt) {
        this.lastBoundaryAt = newest.at;
        this.recentDurationsMs.push(newest.durationMs);
        while (this.recentDurationsMs.length > HISTORICAL_WINDOW) {
          this.recentDurationsMs.shift();
        }
        const dur =
          newest.trigger === "manual"
            ? MANUAL_COMPACT_FLASH_MS
            : AUTO_COMPACT_FLASH_MS;
        this.flashUntil = now + dur;
      }
    }

    return this.buildSnapshot(now);
  }

  reset(): void {
    this.lastBoundaryAt = null;
    this.lastSeenSessionId = null;
    this.recentDurationsMs = [];
    this.flashUntil = null;
  }

  getDiagnostics(): {
    state: "idle" | "flashing-completion";
    estimatedDurationMs: number;
    recentDurationsMs: readonly number[];
  } {
    const now = Date.now();
    const flashActive = this.flashUntil !== null && now < this.flashUntil;
    return {
      state: flashActive ? "flashing-completion" : "idle",
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
    if (this.flashUntil !== null && now < this.flashUntil) {
      return {
        state: "flashing-completion",
        estimatedDurationMs: this.estimateDuration(),
        percent: 100,
        barsFilled: COMPACT_BAR_WIDTH,
        flashUntil: this.flashUntil,
      };
    }
    if (this.flashUntil !== null && now >= this.flashUntil) {
      this.flashUntil = null;
    }
    return {
      state: "idle",
      estimatedDurationMs: this.estimateDuration(),
      percent: 0,
      barsFilled: 0,
      flashUntil: null,
    };
  }
}

/** Width of the compact bar in cells. Exported for the widget
 * renderer so the bar layout stays in sync with the snapshot math
 * without duplicating the constant. */
export const COMPACT_BAR_CELL_COUNT = COMPACT_BAR_WIDTH;
