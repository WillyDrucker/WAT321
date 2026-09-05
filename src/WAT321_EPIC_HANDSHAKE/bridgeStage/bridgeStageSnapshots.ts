import type { BridgeStageSnapshot } from "../../engine/bridgeTypes";
import { CEREMONY_MS, IDLE_SNAPSHOT, type LatchState } from "./bridgeStageMap";
import type { TurnHeartbeat } from "./turnHeartbeat";

/**
 * The snapshot shapes `bridgeStageCoordinator.ts` publishes from one
 * compute pass, plus the synthetic heartbeat that keeps the walker
 * advancing after the dispatcher's heartbeat file disappears at
 * turn-end. Every snapshot in a pass shares the same context fields,
 * so the coordinator resolves them once and hands them in.
 */

/** Fields every snapshot in one compute pass shares. */
export type SnapshotContext = Pick<
  BridgeStageSnapshot,
  "workspacePath" | "returning" | "waitMode" | "codexEffort" | "waitInfo"
>;

/** A turn the walker is displaying, in ceremony while the turn is
 * younger than `CEREMONY_MS` and in stage after. */
export function latchedSnapshot(
  ctx: SnapshotContext,
  latch: LatchState,
  stage: NonNullable<BridgeStageSnapshot["latchedStage"]>,
  heartbeat: TurnHeartbeat,
  now: number
): BridgeStageSnapshot {
  const ceremonyActive = now - latch.turnStartedAt < CEREMONY_MS;
  return {
    ...ctx,
    phase: ceremonyActive ? "ceremony" : "stage",
    latchedStage: stage,
    msInStage: now - latch.displayedAt,
    ceremonyActive,
    paused: false,
    heartbeat,
  };
}

/** The bridge is busy but no heartbeat has landed yet. */
export function preCeremonySnapshot(ctx: SnapshotContext): BridgeStageSnapshot {
  return {
    ...ctx,
    phase: "pre-ceremony",
    latchedStage: null,
    msInStage: 0,
    ceremonyActive: false,
    paused: false,
    heartbeat: null,
  };
}

/** Nothing in flight. The newest heartbeat rides along so readers can
 * still show what last ran. */
export function idleSnapshot(
  ctx: SnapshotContext,
  heartbeat: TurnHeartbeat | null
): BridgeStageSnapshot {
  return { ...IDLE_SNAPSHOT, ...ctx, heartbeat };
}

/** Build a synthetic heartbeat from the latch state so the walker
 * keeps advancing toward `complete` after the dispatcher's heartbeat
 * file disappears at turn-end. `lastTargetStage` is what the walker
 * uses to drive the advance toward completion. */
export function synthesizeHeartbeat(
  latch: LatchState,
  workspacePath: string,
  wsHash: string,
  now: number
): TurnHeartbeat {
  return {
    envelopeId: latch.envelopeId,
    target: latch.target,
    workspacePath,
    workspaceHash: wsHash,
    stage: latch.lastTargetStage,
    activeTool: null,
    toolCallCount: 0,
    elapsedMs: now - latch.turnStartedAt,
    lastProgressAt: now,
    turnStartedAt: latch.turnStartedAt,
  };
}
