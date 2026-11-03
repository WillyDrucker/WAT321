import {
  BRIDGE_STAGE_ORDER,
  RETURNING_FLAG_MS,
  type BridgeStage,
  type BridgeStageSnapshot,
  type BridgeTarget,
  type BridgeWaitMode,
} from "../../engine/bridgeTypes";

/**
 * Stage definitions, timing constants, and shared types for the Epic
 * Handshake bridge. `bridgeStageCoordinator` owns lifecycle and
 * `bridgeStageWalker` the per-tick advance. Each square-N cycle means:
 *
 *   1 dispatched  square-one   / arrow-right  app-server spawning or
 *     thread/start + turn/start dialing in. Exit on turn-started or
 *     rollout task_started.
 *   2 received    square-two   / arrow-right  prompt accepted, initial
 *     reasoning. Exit on the first function_call / web_search_call.
 *   3 working     square-three / blank        active tool use. Exit on
 *     final_answer or the post-tool reasoning threshold.
 *   4 writing     square-four  / blank        final text, arrow-left
 *     once `returning` is set. Exit on task_complete only.
 *   5 complete    square-five  / arrow-left   turn done, reply written,
 *     held so one full cycle is always visible.
 *
 * Stages 1-3 force-advance at `STAGE_MAX_HOLD_MS`. Stages 4 and 5 never
 * force, so stage 5 always means genuine completion.
 */

/** Minimum display time per stage before the walker may advance to
 * the next stage. Sequential walker - never skips even when the
 * monitor's heartbeat jumps two stages in one poll window (Codex
 * emits final_answer and task_complete in the same window, so
 * stage 4 never gets a heartbeat write of its own). Stage 1 gets
 * the longest floor so two full 1Hz blink cycles are visible. */
export const STAGE_LATCH_MS: Record<BridgeStage, number> = {
  dispatched: 4000,
  received: 3000,
  working: 3000,
  writing: 3000,
  complete: RETURNING_FLAG_MS,
};

/** Per-stage maximum display time before the walker force-advances
 * one step even without a higher target signal. Tool-heavy turns
 * spend most of their wall time in `working`, so the parser can sit
 * there until the very last `agent_message`. Without a max-hold the
 * walker pins at stage 3 for a minute+, leaving stage 4 invisible.
 *
 * Stage 1 ceiling guards codex app-server cold start where neither
 * `turn/started` nor a rollout file exists yet. Stage 5 stays at 0:
 * must be driven by `task_complete` so we never claim a turn is done
 * before Codex actually finishes. */
export const STAGE_MAX_HOLD_MS: Record<BridgeStage, number> = {
  dispatched: 30_000,
  received: 15_000,
  working: 30_000,
  writing: 0,
  complete: 0,
};

/** Debug-disconnect / connected ceremony duration after
 * `turnStartedAt`. Drives the `phase: "ceremony"` window during
 * which session-token widgets render the debug ceremony glyphs.
 * Stage 1's min-hold, so both widgets agree on when the ceremony
 * ends. */
export const CEREMONY_MS = STAGE_LATCH_MS.dispatched;

/** Backstop polling interval. fs-watch on the Epic Handshake dir drives most ticks
 * instantly - the timer remains for time-based progressions
 * (ceremony window expiring, stage min-hold elapsing during
 * dispatcher silence). */
export const TICK_INTERVAL_MS = 1000;

/** How long the coordinator stays idle before the polling timer
 * suspends itself. fs-watch keeps state correct in the meantime -
 * suspending saves the 1Hz fs op cost during long idle stretches.
 * The next fs-watch event resumes the timer immediately. */
export const IDLE_SUSPEND_MS = 30_000;

/** Coalesce fs-watch fire bursts. Atomic tmp+rename triggers 2-3
 * events in rapid succession - 50ms absorbs the burst without feeling
 * laggy. */
export const WATCH_DEBOUNCE_MS = 50;

/** Stage 5 hold after the synthetic walker reaches `complete` but
 * before we release the envelope. Keeps stage 5 visible briefly
 * even after the dispatcher's heartbeat file has been removed. */
export const COMPLETE_WALK_HOLD_MS = 3000;

/** Grace window before dropping a latch whose heartbeat went missing
 * AND whose lastTargetStage is not yet `complete`. Covers the cancel
 * / bridge-error path where the dispatcher tears down the heartbeat
 * without ever writing stage=complete. Latches that DID reach a
 * complete target are honored regardless of grace. */
export const LATCH_ORPHAN_GRACE_MS = 3000;

/** Compressed min-hold for stages 2-4 once the turn has reached its
 * `complete` target and the walker is only catching up. Stage 1 keeps
 * its full floor for the ceremony and stage 5 its full hold, so a fast
 * turn still flashes stages 3 and 4 instead of skipping them. */
export const FAST_WALK_INTERMEDIATE_MS = 500;

export function stageIdx(s: BridgeStage): number {
  return BRIDGE_STAGE_ORDER.indexOf(s);
}

export interface LatchState {
  envelopeId: string;
  displayedStage: BridgeStage;
  displayedAt: number;
  /** Wall-clock of the underlying turn's start (heartbeat
   * `turnStartedAt`). Drives ceremony detection. Falls back to
   * latch entry when the heartbeat lacks a turn start. */
  turnStartedAt: number;
  /** Set when the synthetic walker reaches `complete` - gives stage
   * 5 its hold window before the coordinator releases the envelope. */
  completeWalkAt: number | null;
  /** Highest stage seen on this envelope's heartbeat across reads.
   * Lets the walker keep advancing toward `complete` after the
   * heartbeat file is unlinked - otherwise stages 4-5 commonly
   * never display because the dispatcher tears down its heartbeat
   * at turn-end while the walker is still walking. */
  lastTargetStage: BridgeStage;
  /** Wall-clock when the heartbeat file first became unreadable on
   * this envelope. Drives the orphan-grace timeout. Reset to null
   * whenever a fresh heartbeat read succeeds. */
  lostHeartbeatAt: number | null;
  /** Wait mode the dispatcher resolved for this turn, captured from
   * the first heartbeat. Plumbs per-call FF / adaptive args through
   * to `snapshot.waitMode` so the Claude session-tokens widget
   * bypasses the bridge ceremony correctly on FF dispatches. */
  waitMode?: BridgeWaitMode;
  /** Backend that owns this turn, captured from the first heartbeat.
   * Persists across the walker's lifetime so off-target ceremony
   * suppression in the Codex widget reads a stable value even after
   * the raw heartbeat clears. */
  target: BridgeTarget;
}

export const IDLE_SNAPSHOT: BridgeStageSnapshot = {
  workspacePath: null,
  phase: "idle",
  latchedStage: null,
  msInStage: 0,
  ceremonyActive: false,
  returning: false,
  paused: false,
  heartbeat: null,
  waitMode: "adaptive",
  codexEffort: null,
  waitInfo: null,
};
