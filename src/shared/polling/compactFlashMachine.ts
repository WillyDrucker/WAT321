/**
 * Provider-agnostic compact-completion flash state machine.
 *
 * Both Claude and Codex buffer their compact markers until the
 * operation finishes - the only observable signal is the boundary
 * entry at the end (`compact_boundary` for Claude, `compacted` for
 * Codex). So the machine is end-only: on a newly-observed boundary,
 * arm a brief completion flash; otherwise idle.
 *
 * Provider parsers stay tier-local and feed a normalized
 * `CompactObservation` (newest boundary timestamp, the flash hold to
 * use, recent durations for the diagnostic) into `sync`. The machine
 * owns only the cross-provider state transition: dedupe by timestamp,
 * suppress the flash on session attach, and self-narrow back to idle
 * once `flashUntil` passes. No provider-specific parsing leaks in,
 * which keeps the shared -> tool dependency direction intact.
 */

/** Default duration estimate surfaced by the health command when no
 * boundary durations are available (Codex never reports duration). */
const DEFAULT_DURATION_MS = 120_000;

/** Width of the compact flash bar in cells. Five matches the usage
 * widgets' compact-mode bar so the visual rhythm stays consistent.
 * Flash always renders all five filled. */
export const COMPACT_BAR_CELL_COUNT = 5;

/** Normalized, provider-agnostic view of compact state derived from a
 * transcript / rollout tail. Provider parsers produce this; the shared
 * machine consumes it. */
export interface CompactObservation {
  /** Timestamp (ms) of the newest compact boundary in the tail, or
   * null when none is present. */
  newestBoundaryAt: number | null;
  /** Flash hold to arm when a newly-observed boundary fires. Claude
   * varies it by trigger (manual longer than auto); Codex passes a
   * single fixed value since its marker carries no trigger field. */
  flashDurationMs: number;
  /** Recent boundary durations (ms) for the health-command estimate.
   * Claude supplies real values from `compactMetadata.durationMs`;
   * Codex has no duration field and supplies an empty array. */
  recentDurationsMs: readonly number[];
}

export interface CompactFlashSnapshot {
  state: "idle" | "flashing-completion";
  /** Current best estimate of total compact duration in ms. Rolling
   * average of recent boundary durations, or the default. Health-
   * command diagnostic only; no visual effect. */
  estimatedDurationMs: number;
  /** 100 during flash (saturated final reading), 0 when idle. */
  percent: number;
  /** Filled cells in the bar. Flash uses all five; idle = 0. */
  barsFilled: number;
  /** Wall-clock ms at which a `flashing-completion` window expires.
   * The widget consults this on every ticker frame so the flash
   * collapses the instant the window passes. Null outside the flash. */
  flashUntil: number | null;
}

export class CompactFlashMachine {
  private lastBoundaryAt: number | null = null;
  private lastSeenSessionId: string | null = null;
  private recentDurationsMs: number[] = [];
  private flashUntil: number | null = null;

  /** Fold a fresh observation into the machine and return the current
   * snapshot. Idempotent: re-syncing the same observation yields the
   * same snapshot (the boundary timestamp dedupe makes the flash fire
   * exactly once per distinct compact). */
  sync(args: {
    sessionId: string;
    observation: CompactObservation;
    now: number;
  }): CompactFlashSnapshot {
    const { sessionId, observation, now } = args;

    // Session attach: adopt the newest historical boundary as
    // already-seen so a tail that already contains a compact does NOT
    // flash for an event we never observed live. Re-seed the estimate
    // history from the same observation.
    if (sessionId !== this.lastSeenSessionId) {
      this.flashUntil = null;
      this.lastSeenSessionId = sessionId;
      this.recentDurationsMs = [...observation.recentDurationsMs];
      this.lastBoundaryAt = observation.newestBoundaryAt;
      return this.buildSnapshot(now);
    }

    // Keep the estimate fresh every sync.
    this.recentDurationsMs = [...observation.recentDurationsMs];

    // A boundary newer than what we've adopted means a compact just
    // completed. Arm the flash once.
    if (
      observation.newestBoundaryAt !== null &&
      (this.lastBoundaryAt === null ||
        observation.newestBoundaryAt > this.lastBoundaryAt)
    ) {
      this.lastBoundaryAt = observation.newestBoundaryAt;
      this.flashUntil = now + observation.flashDurationMs;
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

  private buildSnapshot(now: number): CompactFlashSnapshot {
    if (this.flashUntil !== null && now < this.flashUntil) {
      return {
        state: "flashing-completion",
        estimatedDurationMs: this.estimateDuration(),
        percent: 100,
        barsFilled: COMPACT_BAR_CELL_COUNT,
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
