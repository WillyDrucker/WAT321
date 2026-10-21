import type { BridgeStage, BridgeWaitMode } from "../../engine/bridgeTypes";
import type { Heartbeat } from "../../engine/heartbeat/heartbeatTypes";
import { deleteHeartbeat, writeHeartbeat } from "../../engine/heartbeat/heartbeatWriter";
import type { EpicHandshakeLogger } from "../epicHandshakeLogger";

/**
 * Per-turn heartbeat writer for Codex turns. `runTurnOnce` writes
 * through this factory so stage-entry stamping and the turn clock
 * live in one place, while the file itself goes through the engine
 * writer every backend shares. The engine keys heartbeats by dispatch
 * id, which for a Codex turn is the envelope id.
 */

interface HeartbeatStageInfo {
  activeTool?: { name: string } | null;
  toolCallCount: number;
  elapsedMs: number;
}

interface HeartbeatWriterOptions {
  envelopeId: string;
  workspacePath: string;
  wsHash: string;
  waitMode: BridgeWaitMode;
  logger: EpicHandshakeLogger;
}

export interface HeartbeatWriter {
  /** Write a heartbeat at the given stage. Stage entry is stamped on
   * first observation - subsequent calls at the same stage refresh
   * `lastProgressAt` without bumping the stamp. */
  write(stage: BridgeStage, info?: HeartbeatStageInfo): void;
  /** Latest stage this writer has observed. The liveness heartbeat
   * re-emits at this stage so a long quiet stretch does not regress
   * the displayed stage to `dispatched`. */
  lastStage(): BridgeStage;
  /** Wall-clock when the turn started (writer construction time).
   * Drives the ceremony window and per-stage elapsed displays. */
  startedAt(): number;
  /** Schedule the heartbeat file for deletion after `delayMs`. The
   * status-bar walker needs the file to remain at `stage=complete`
   * long enough to render each remaining stage's 3s min-hold (5
   * stages * 3s = 15s worst case) - deleting on the same tick as
   * turn end strands the walker at the last intermediate stage. */
  scheduleCleanup(delayMs: number): void;
}

export function createHeartbeatWriter(
  opts: HeartbeatWriterOptions
): HeartbeatWriter {
  const stageEnteredAt: Partial<Record<BridgeStage, number>> = {};
  const turnStartedAt = Date.now();
  let lastObservedStage: BridgeStage = "dispatched";

  return {
    write(stage, info) {
      lastObservedStage = stage;
      if (stageEnteredAt[stage] === undefined) {
        const enteredAt = Date.now();
        stageEnteredAt[stage] = enteredAt;
        // Log first-time stage entry with elapsed-since-dispatch so
        // post-mortem timing can answer "why did the status bar pin
        // on stage N" without guessing. Same-stage refreshes are
        // silent.
        const ms = enteredAt - turnStartedAt;
        opts.logger.info(
          `[stage] envelope=${opts.envelopeId} -> ${stage} at +${ms}ms (tools=${info?.toolCallCount ?? 0})`
        );
      }
      const heartbeat: Heartbeat = {
        dispatchId: opts.envelopeId,
        target: "codex",
        workspacePath: opts.workspacePath,
        workspaceHash: opts.wsHash,
        stage,
        activeTool: info?.activeTool?.name ?? null,
        toolCallCount: info?.toolCallCount ?? 0,
        elapsedMs: info?.elapsedMs ?? 0,
        lastProgressAt: Date.now(),
        turnStartedAt,
        stageEnteredAt,
        // The resolved wait mode rides on the heartbeat so the stage
        // coordinator drives `snapshot.waitMode` from the active turn
        // rather than the sticky flag - per-call FF / adaptive args
        // would otherwise be invisible to the widget animation gate.
        waitMode: opts.waitMode,
      };
      writeHeartbeat(heartbeat);
    },
    lastStage() {
      return lastObservedStage;
    },
    startedAt() {
      return turnStartedAt;
    },
    scheduleCleanup(delayMs) {
      const t = setTimeout(() => deleteHeartbeat(opts.envelopeId), delayMs);
      t.unref?.();
    },
  };
}
