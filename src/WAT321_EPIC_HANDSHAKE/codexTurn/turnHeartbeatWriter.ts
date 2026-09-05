import { existsSync, unlinkSync } from "node:fs";
import { writeFileAtomic } from "../../engine/fs/atomicWrite";
import { turnHeartbeatPath } from "../epicHandshakePaths";
import type { EpicHandshakeLogger } from "../epicHandshakeLogger";
import type { WaitMode } from "./waitMode";

/**
 * Per-turn heartbeat writer. The bridge status bar widget polls the
 * heartbeat file every second to drive its stage glyph, latch, and
 * tooltip - `runTurnOnce` writes through this factory so the file
 * format and atomic write semantics live in one place.
 *
 * Atomic tmp+rename is load-bearing - the status-bar reader runs
 * concurrent with the writer and would otherwise observe a mid-flush
 * file as a JSON parse error, falling back to a legacy animation
 * that visibly conflicts with the stage glyph the user expects.
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
  waitMode: WaitMode;
  logger: EpicHandshakeLogger;
}

export interface HeartbeatWriter {
  /** Write a heartbeat at the given stage. Stage entry is stamped on
   * first observation - subsequent calls at the same stage refresh
   * `lastProgressAt` without bumping the stamp. */
  write(stage: string, info?: HeartbeatStageInfo): void;
  /** Latest stage this writer has observed. The liveness heartbeat
   * re-emits at this stage so a long quiet stretch does not regress
   * the displayed stage to `dispatched`. */
  lastStage(): string;
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
  const heartbeatFile = turnHeartbeatPath(opts.envelopeId);
  const stageEnteredAt: Partial<Record<string, number>> = {};
  const turnStartedAt = Date.now();
  let lastObservedStage = "dispatched";

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
      const body = JSON.stringify({
        envelopeId: opts.envelopeId,
        workspacePath: opts.workspacePath,
        workspaceHash: opts.wsHash,
        stage,
        activeTool: info?.activeTool?.name ?? null,
        toolCallCount: info?.toolCallCount ?? 0,
        elapsedMs: info?.elapsedMs ?? 0,
        lastProgressAt: Date.now(),
        turnStartedAt,
        stageEnteredAt,
        // Stamp the resolved wait mode so the BridgeStageCoordinator
        // drives `snapshot.waitMode` from the active turn rather than
        // the sticky flag - per-call FF / adaptive args would
        // otherwise be invisible to the widget animation gate.
        waitMode: opts.waitMode,
      });
      writeFileAtomic(heartbeatFile, body);
    },
    lastStage() {
      return lastObservedStage;
    },
    startedAt() {
      return turnStartedAt;
    },
    scheduleCleanup(delayMs) {
      const t = setTimeout(() => {
        try {
          if (existsSync(heartbeatFile)) unlinkSync(heartbeatFile);
        } catch {
          // best-effort
        }
      }, delayMs);
      t.unref?.();
    },
  };
}
