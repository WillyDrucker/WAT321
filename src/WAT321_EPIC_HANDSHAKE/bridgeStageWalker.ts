import type { BridgeStage, BridgeWaitMode } from "../engine/bridgeTypes";
import type { TurnHeartbeat } from "./turnHeartbeat";
import {
  COMPLETE_WALK_HOLD_MS,
  FAST_WALK_INTERMEDIATE_MS,
  STAGE_LATCH_MS,
  STAGE_MAX_HOLD_MS,
  STAGE_ORDER,
  stageIdx,
  type LatchState,
} from "./bridgeStageMap";

/**
 * Pure stage-walker over the Epic Handshake bridge latch. Given the
 * previous latch and a heartbeat, returns the next latch + the stage
 * to display this tick. Owned by the coordinator; no I/O, no mutation
 * of its inputs.
 *
 * Three transitions live here:
 *   - New envelope: walker always restarts at `dispatched` so stage 1
 *     gets visible time even when the heartbeat's first write is
 *     `received` (the monitor's task_started often beats the
 *     coordinator's 1s tick).
 *   - Same envelope, hold: target is at-or-below displayed stage and
 *     no force-advance is due. Tracks the complete-walk-hold window
 *     when the latch is sitting on stage 5 and signals release once
 *     the hold elapses.
 *   - Same envelope, advance: target is ahead OR max-hold elapsed.
 *     Respects the min-hold floor (compressed when the turn has
 *     already reached its `complete` target and the walker is just
 *     catching up).
 */

export interface AdvanceLatchResult {
  /** The new latch state. `null` when the walker has released (turn
   * is done + complete-walk-hold elapsed). */
  nextLatch: LatchState | null;
  /** Stage to display this tick. `null` when the walker has released
   * and the coordinator should fall through to its no-latch path. */
  displayedStage: BridgeStage | null;
  /** Envelope id to record as "just-completed" so the coordinator's
   * stale-heartbeat suppression catches the next compute tick. `null`
   * when no release happened this tick. */
  releasedEnvelopeId: string | null;
}

/** Advance the latch one tick. Pure function over (prevLatch, hb,
 * now). The coordinator handles I/O (reading heartbeats, deciding
 * whether to call us at all, handling orphan grace) and re-assigns
 * `this.latchState` from the returned `nextLatch`. */
export function advanceLatch(
  prevLatch: LatchState | null,
  hb: TurnHeartbeat,
  now: number
): AdvanceLatchResult {
  if (prevLatch === null || prevLatch.envelopeId !== hb.envelopeId) {
    return startNewEnvelope(hb, now);
  }

  // Refresh lastTargetStage from the heartbeat - it only moves
  // forward, never backward, so the walker keeps progressing toward
  // `complete` even after the heartbeat file disappears.
  const carriedTargetIdx = stageIdx(prevLatch.lastTargetStage);
  const hbTargetIdx = stageIdx(hb.stage);
  const refreshedTarget: BridgeStage =
    hbTargetIdx > carriedTargetIdx ? hb.stage : prevLatch.lastTargetStage;

  const displayedIdx = stageIdx(prevLatch.displayedStage);
  const targetIdx = stageIdx(hb.stage);
  const heldMs = now - prevLatch.displayedAt;
  const minMs = STAGE_LATCH_MS[prevLatch.displayedStage];
  const maxMs = STAGE_MAX_HOLD_MS[prevLatch.displayedStage];

  // Force-advance only for stages 2-4 (max-hold > 0), when the parser
  // has not signaled a higher target. Never auto-steps into stage 5 -
  // that's reserved for genuine task_complete.
  const shouldForceAdvance =
    targetIdx <= displayedIdx &&
    maxMs > 0 &&
    heldMs >= maxMs &&
    displayedIdx + 1 < STAGE_ORDER.length - 1;

  if (targetIdx <= displayedIdx && !shouldForceAdvance) {
    return holdStage(prevLatch, refreshedTarget, now);
  }
  return advanceStage(prevLatch, refreshedTarget, displayedIdx, minMs, heldMs, now);
}

/** First tick of a fresh envelope. Always starts at `dispatched` so
 * stage 1 gets visible time even when the heartbeat's very first
 * write is `received`. */
function startNewEnvelope(hb: TurnHeartbeat, now: number): AdvanceLatchResult {
  return {
    nextLatch: {
      envelopeId: hb.envelopeId,
      displayedStage: "dispatched",
      displayedAt: now,
      turnStartedAt: hb.turnStartedAt ?? now,
      completeWalkAt: null,
      lastTargetStage: hb.stage,
      lostHeartbeatAt: null,
      waitMode: hb.waitMode as BridgeWaitMode | undefined,
      target: hb.target,
    },
    displayedStage: "dispatched",
    releasedEnvelopeId: null,
  };
}

/** Hold path: target is at-or-below displayed, no force-advance is
 * due. Tracks the complete-walk-hold window when the latch sits on
 * stage 5; releases the latch once that window elapses. */
function holdStage(
  prevLatch: LatchState,
  refreshedTarget: BridgeStage,
  now: number
): AdvanceLatchResult {
  let completeWalkAt = prevLatch.completeWalkAt;
  if (prevLatch.displayedStage === "complete" && completeWalkAt === null) {
    completeWalkAt = now;
  }
  if (completeWalkAt !== null && now - completeWalkAt >= COMPLETE_WALK_HOLD_MS) {
    return {
      nextLatch: null,
      displayedStage: null,
      releasedEnvelopeId: prevLatch.envelopeId,
    };
  }
  return {
    nextLatch: {
      ...prevLatch,
      completeWalkAt,
      lastTargetStage: refreshedTarget,
    },
    displayedStage: prevLatch.displayedStage,
    releasedEnvelopeId: null,
  };
}

/** Advance path: target is ahead OR max-hold elapsed. Respects the
 * min-hold floor, compressed when the turn has already reached its
 * `complete` target and the walker is just catching up. */
function advanceStage(
  prevLatch: LatchState,
  refreshedTarget: BridgeStage,
  displayedIdx: number,
  minMs: number,
  heldMs: number,
  now: number
): AdvanceLatchResult {
  const targetIsComplete = stageIdx(refreshedTarget) === stageIdx("complete");
  const fastWalkApplies =
    targetIsComplete &&
    (prevLatch.displayedStage === "received" ||
      prevLatch.displayedStage === "working" ||
      prevLatch.displayedStage === "writing");
  const effectiveMinMs = fastWalkApplies ? FAST_WALK_INTERMEDIATE_MS : minMs;
  if (heldMs < effectiveMinMs) {
    return {
      nextLatch: { ...prevLatch, lastTargetStage: refreshedTarget },
      displayedStage: prevLatch.displayedStage,
      releasedEnvelopeId: null,
    };
  }
  const nextStage = STAGE_ORDER[displayedIdx + 1];
  return {
    nextLatch: {
      envelopeId: prevLatch.envelopeId,
      displayedStage: nextStage,
      displayedAt: now,
      turnStartedAt: prevLatch.turnStartedAt,
      completeWalkAt: null,
      lastTargetStage: refreshedTarget,
      lostHeartbeatAt: prevLatch.lostHeartbeatAt,
      waitMode: prevLatch.waitMode,
      target: prevLatch.target,
    },
    displayedStage: nextStage,
    releasedEnvelopeId: null,
  };
}

