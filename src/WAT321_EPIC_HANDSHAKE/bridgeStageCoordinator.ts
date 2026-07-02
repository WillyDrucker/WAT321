import { existsSync, watch, type FSWatcher } from "node:fs";
import * as vscode from "vscode";
import type {
  BridgeStageReader,
  BridgeStageSnapshot,
  BridgeWaitMode,
} from "../engine/bridgeTypes";
import type { EventHub } from "../engine/eventHub";
import { workspaceHash } from "../shared/workspaceHash";
import {
  CEREMONY_MS,
  EH_DIR,
  IDLE_SNAPSHOT,
  IDLE_SUSPEND_MS,
  LATCH_ORPHAN_GRACE_MS,
  TICK_INTERVAL_MS,
  WATCH_DEBOUNCE_MS,
  type LatchState,
} from "./bridgeStageMap";
import { advanceLatch } from "./bridgeStageWalker";
import { returningFlagPath } from "./constants";
import { readCodexEffortOverride } from "./codexRuntimeOverrides";
import { isBridgeBusy, isPaused } from "./statusBarState";
import {
  readNewestHeartbeat,
  type TurnHeartbeat,
} from "./turnHeartbeat";
import { currentWaitMode } from "./waitMode";
import { readWaitStatus } from "./waitStatus";

/**
 * Single source of truth for Epic Handshake bridge state across the
 * status bar surface. Owns lifecycle (polling timer with idle-suspend,
 * fs-watch on the EH directory), the latch field, and the per-tick
 * `compute()` orchestration. Delegates the stage-walker logic to
 * `bridgeStageWalker.advanceLatch` (pure function) and the constants
 * / types to `bridgeStageMap`.
 *
 * The bridge widget, Claude session tokens, and Codex session tokens
 * all read `snapshot()` and observe the same latched stage at the
 * same wall-clock instant - no drift, no parallel ceremony timers.
 */
export class BridgeStageCoordinator
  implements vscode.Disposable, BridgeStageReader
{
  private latchState: LatchState | null = null;
  private lastSnapshot: BridgeStageSnapshot = IDLE_SNAPSHOT;
  private interval: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastNonIdleAt = Date.now();
  /** Envelope id of the most-recently-completed turn the walker
   * finished. The heartbeat file lingers on disk for ~120s past turn
   * end, so without this latch-suppression the next compute tick
   * would start a fresh latch on the stale heartbeat and replay
   * stages 1-5. Cleared when a new envelope id appears. */
  private lastCompletedEnvelopeId: string | null = null;

  constructor(private readonly events: EventHub) {}

  /** Begin self-driven monitoring. Idempotent - second call no-ops. */
  start(): void {
    if (this.interval !== null) return;
    this.tick();
    this.resumeTimer();
    this.attachWatcher();
  }

  private resumeTimer(): void {
    if (this.interval !== null) return;
    this.interval = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  private suspendTimer(): void {
    if (this.interval === null) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  /** Lazy-attach fs.watch on EH_DIR. Created by the EH tier on
   * activate - if missing here we'll retry on the next tick once the
   * tier creates it. Watch failure is non-fatal - the polling timer
   * keeps state fresh regardless. */
  private attachWatcher(): void {
    if (this.watcher !== null) return;
    if (!existsSync(EH_DIR)) return;
    try {
      this.watcher = watch(EH_DIR, { persistent: false }, () => {
        if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          this.resumeTimer();
          this.tick();
        }, WATCH_DEBOUNCE_MS);
      });
      this.watcher.on("error", () => this.detachWatcher());
    } catch {
      this.watcher = null;
    }
  }

  private detachWatcher(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher !== null) {
      try {
        this.watcher.close();
      } catch {
        // best-effort
      }
      this.watcher = null;
    }
  }

  /** Recompute the snapshot from current heartbeat + flag state.
   * Emits `bridge.phaseChanged` and `bridge.stageChanged` on
   * transitions. Called automatically by the polling timer and the
   * fs-watch debounce - external callers can tick manually. */
  tick(): BridgeStageSnapshot {
    if (this.watcher === null) this.attachWatcher();
    const next = this.compute();
    const prev = this.lastSnapshot;
    this.lastSnapshot = next;
    if (prev.phase !== next.phase) {
      this.events.emit("bridge.phaseChanged", {
        from: prev.phase,
        to: next.phase,
        workspacePath: next.workspacePath,
      });
    }
    if (prev.latchedStage !== next.latchedStage) {
      this.events.emit("bridge.stageChanged", {
        from: prev.latchedStage,
        to: next.latchedStage,
        workspacePath: next.workspacePath,
      });
    }
    const now = Date.now();
    if (next.phase !== "idle") {
      this.lastNonIdleAt = now;
    } else if (now - this.lastNonIdleAt >= IDLE_SUSPEND_MS) {
      this.suspendTimer();
    }
    return next;
  }

  snapshot(): BridgeStageSnapshot {
    return this.lastSnapshot;
  }

  /** Push notification on phase or stage transition. Session-token
   * widgets gate animations on bridge state but their own poll
   * cadence misses the first dispatch after a cold launch - this
   * delivers a single fire on every transition. Returns a disposer. */
  onChange(handler: () => void): { dispose(): void } {
    const subs = [
      this.events.on("bridge.phaseChanged", () => handler()),
      this.events.on("bridge.stageChanged", () => handler()),
    ];
    return {
      dispose: () => {
        for (const s of subs) s.dispose();
      },
    };
  }

  dispose(): void {
    this.suspendTimer();
    this.detachWatcher();
    this.latchState = null;
    this.lastSnapshot = IDLE_SNAPSHOT;
  }

  private compute(): BridgeStageSnapshot {
    const workspacePath =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    if (workspacePath === null) {
      this.latchState = null;
      return { ...IDLE_SNAPSHOT, workspacePath: null };
    }

    if (isPaused()) {
      this.latchState = null;
      return { ...IDLE_SNAPSHOT, workspacePath, paused: true };
    }

    const wsHash = workspaceHash(workspacePath);
    const returning = existsSync(returningFlagPath(wsHash));
    // Pass the active latch's envelope so the reader returns that
    // turn's heartbeat even when a parallel backend has written a
    // fresher-mtime file for a different envelope. Without this, the
    // single-latch coordinator would oscillate between envelopes and
    // the Codex ceremony would visibly replay.
    const rawHeartbeat = readNewestHeartbeat(
      wsHash,
      this.latchState?.envelopeId
    );
    const busy = isBridgeBusy(workspacePath);
    const waitMode: BridgeWaitMode =
      this.latchState?.waitMode ??
      (rawHeartbeat?.waitMode as BridgeWaitMode | undefined) ??
      currentWaitMode(workspacePath);
    const codexEffort = readCodexEffortOverride(wsHash);
    const waitInfo = readWaitStatus(wsHash);
    const now = Date.now();

    if (this.latchState !== null) {
      const matchedHb =
        rawHeartbeat !== null &&
        rawHeartbeat.envelopeId === this.latchState.envelopeId
          ? rawHeartbeat
          : null;
      if (matchedHb !== null) {
        this.latchState = { ...this.latchState, lostHeartbeatAt: null };
      } else if (this.latchState.lostHeartbeatAt === null) {
        this.latchState = { ...this.latchState, lostHeartbeatAt: now };
      }

      const orphaned =
        this.latchState.lostHeartbeatAt !== null &&
        this.latchState.lastTargetStage !== "complete" &&
        now - this.latchState.lostHeartbeatAt >= LATCH_ORPHAN_GRACE_MS;
      if (orphaned) {
        this.latchState = null;
      } else {
        const hbForWalker: TurnHeartbeat =
          matchedHb ?? synthesizeHeartbeat(this.latchState, workspacePath, wsHash, now);
        const result = advanceLatch(this.latchState, hbForWalker, now);
        this.latchState = result.nextLatch;
        if (result.releasedEnvelopeId !== null) {
          this.lastCompletedEnvelopeId = result.releasedEnvelopeId;
        }
        if (result.displayedStage !== null && this.latchState !== null) {
          const ceremonyActive =
            now - this.latchState.turnStartedAt < CEREMONY_MS;
          return {
            workspacePath,
            phase: ceremonyActive ? "ceremony" : "stage",
            latchedStage: result.displayedStage,
            msInStage: now - this.latchState.displayedAt,
            ceremonyActive,
            returning,
            paused: false,
            heartbeat: hbForWalker,
            waitMode,
            codexEffort,
            waitInfo,
          };
        }
      }
    }

    // No active latch (or just released). Start a new one when there's
    // a heartbeat that isn't the just-completed envelope. Covers both
    // the normal pre-ceremony -> stage 1 path AND the VS Code reload
    // mid long-adaptive-turn case where flags went stale but the
    // dispatcher is still emitting heartbeats.
    if (
      rawHeartbeat !== null &&
      rawHeartbeat.envelopeId !== this.lastCompletedEnvelopeId
    ) {
      const result = advanceLatch(null, rawHeartbeat, now);
      this.latchState = result.nextLatch;
      this.lastCompletedEnvelopeId = null;
      if (result.displayedStage !== null && this.latchState !== null) {
        const ceremonyActive =
          now - this.latchState.turnStartedAt < CEREMONY_MS;
        return {
          workspacePath,
          phase: ceremonyActive ? "ceremony" : "stage",
          latchedStage: result.displayedStage,
          msInStage: now - this.latchState.displayedAt,
          ceremonyActive,
          returning,
          paused: false,
          heartbeat: rawHeartbeat,
          waitMode,
          codexEffort,
          waitInfo,
        };
      }
    }

    if (busy) {
      return {
        workspacePath,
        phase: "pre-ceremony",
        latchedStage: null,
        msInStage: 0,
        ceremonyActive: false,
        returning,
        paused: false,
        heartbeat: null,
        waitMode,
        codexEffort,
        waitInfo,
      };
    }

    return {
      ...IDLE_SNAPSHOT,
      workspacePath,
      returning,
      heartbeat: rawHeartbeat,
      waitMode,
      codexEffort,
      waitInfo,
    };
  }

}

/** Build a synthetic heartbeat from the latch state so the walker
 * keeps advancing toward `complete` after the dispatcher's heartbeat
 * file disappears at turn-end. `lastTargetStage` is what the walker
 * uses to drive the advance toward completion. */
function synthesizeHeartbeat(
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
