import { homedir } from "node:os";
import { join } from "node:path";
import { BRIDGE_STAGE_ORDER, type BridgeStageSnapshot, type BridgeWaitMode, type BridgeStage } from "../../engine/bridgeTypes";

/**
 * Stage definitions, timing constants, and shared types for the Epic
 * Handshake bridge state machine. `bridgeStageCoordinator` owns
 * lifecycle and orchestration - `bridgeStageWalker` owns the per-tick
 * advance logic - this file owns what the stages mean.
 *
 * Stage map - what each square-N cycle means:
 *
 *   1 dispatched   square-one   <-> arrow-right   outbound to Codex
 *     Codex side:  app-server child spawning OR thread/start +
 *                  turn/start being dialed in. Cold first dispatch
 *                  can run ~20s - subsequent dispatches over the same
 *                  connection move through in <1s.
 *     Entry:       writeHeartbeat("dispatched") when turnRunner starts.
 *     Exit:        observeRpcProgress("turn-started") or rollout
 *                  task_started. Force-exit at 30s ceiling.
 *
 *   2 received     square-two   <-> arrow-right   prompt accepted
 *     Codex side:  initial reasoning before any tool call.
 *     Entry:       task_started rollout event or turn/started RPC.
 *     Exit:        first function_call / web_search_call response item
 *                  or force-advance after 15s.
 *
 *   3 working      square-three <-> blank          Codex working
 *     Codex side:  active tool use - 80-95% of wall time on tool-
 *                  heavy turns.
 *     Entry:       first function_call or web_search_call entry.
 *     Exit:        agent_message phase=final_answer or post-tool
 *                  reasoning threshold or force-advance after 30s.
 *
 *   4 writing      square-four  <-> blank          composing answer
 *   4 + returning  square-four  <-> arrow-left     reply imminent
 *     Codex side:  final assistant message text being produced.
 *     Entry:       agent_message phase=final_answer or post-tool
 *                  reasoning heuristic.
 *     Exit:        task_complete. No force-advance - stage 5 is
 *                  reserved for genuine completion.
 *
 *   5 complete     square-five  <-> arrow-left     delivered back
 *     Codex side:  turn done, bridge writing the reply envelope.
 *     Entry:       task_complete or turn/completed RPC.
 *     Exit:        held 3s + COMPLETE_WALK_HOLD_MS so one full cycle
 *                  is always visible, then widget transitions to the
 *                  returning-arrow handoff animation.
 */

/** Minimum display time per stage before the walker may advance to
 * the next stage. Sequential walker - never skips even when the
 * monitor's heartbeat jumps two stages in one poll window (Codex
 * emits final_answer and task_complete in the same 5s window, so
 * stage 4 never gets a heartbeat write of its own). Stage 1 gets
 * the longest floor so two full 1Hz blink cycles are visible. */
export const STAGE_LATCH_MS: Record<BridgeStage, number> = {
  dispatched: 4000,
  received: 3000,
  working: 3000,
  writing: 3000,
  complete: 3000,
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
 * Aligned with stage 1's min-hold so both widgets agree on when
 * the ceremony ends. */
export const CEREMONY_MS = 4000;

/** Backstop polling interval. fs-watch on EH_DIR drives most ticks
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

/** Bridge state directory the coordinator watches and reads. */
export const EH_DIR = join(homedir(), ".wat321", "epic-handshake");

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

/** Compressed min-hold for intermediate stages (received, working,
 * writing) when Codex has already finished and the walker just needs
 * to catch up. Triggered when lastTargetStage reaches `complete`
 * while the walker is still walking. Stage 1 keeps its full floor
 * for the ceremony - stage 5 keeps its full hold + completion window.
 * 500ms lets stages 3 and 4 flash visibly on a sub-12s fast turn
 * instead of being skipped invisibly. */
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
  target?: "codex" | "opencode" | "local";
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
