import { statSync } from "node:fs";
import { BRIDGE_STAGE_ORDER, type BridgeStage } from "../../engine/bridgeTypes";
import { readTail } from "../../engine/fs/fileReaders";
import { parseStageInfo } from "../../shared/codex-rollout/stageInfoParser";
import type { StageInfo } from "../../shared/codex-rollout/turnStageTypes";
import {
  resolveTurnMonitorOptions,
  type MonitorSnapshot,
  type ResolvedTurnMonitorOptions,
  type RpcProgressKind,
  type TurnMonitorOptions,
} from "./turnMonitorOptions";
import { stallWindowFor } from "./turnMonitorStallWindow";
import { TurnMonitorTimers } from "./turnMonitorTimers";

/**
 * Adaptive turn watchdog for the Epic Handshake dispatcher. Replaces
 * the single 300s wall-clock timeout with a progress-aware state
 * machine driven by:
 *
 *   - RPC notification observations (`turn/started`, `item/started`,
 *     `item/completed`, `item/agentMessage/delta`) - fed in via
 *     `observeRpcProgress()`.
 *   - Rollout file polling every `pollIntervalMs` - reads the tail,
 *     runs `parseStageInfo`, detects phase advances and fresh
 *     activity (mtime bumps catch `token_count` and `reasoning`
 *     events that do not surface at item-level in the RPC stream).
 *
 * Budget windows:
 *
 *   - Phase 0 -> 1: `phase0WindowMs` from start until `task_started`
 *     or `turn/started` observed. Timeout = hard fail
 *     ("Codex never activated").
 *   - Phase 1 onward: tool-aware window since any progress signal -
 *     see `turnMonitorStallWindow.ts` for the per-tool table.
 *     Timeout = soft fail ("Codex stalled during <tool>").
 *   - `hardCapMs`: absolute wall-clock ceiling. Timeout = hard fail
 *     ("Codex exceeded max turn duration").
 *
 * Callers drive completion from outside. The monitor reports stall
 * or cap via `onStall` / `onHardCap`, and the caller sends
 * `turn/interrupt` + writes the error envelope. Successful turn
 * completion is the caller's responsibility (turn/completed RPC or
 * rollout task_complete) - the monitor just stops when `stop()` is
 * invoked. Timer handles live in `turnMonitorTimers.ts`.
 */

export class TurnMonitor {
  private readonly options: ResolvedTurnMonitorOptions;
  private readonly timers = new TurnMonitorTimers();
  private resolvedRolloutPath: string | null = null;
  private started = false;
  private stopped = false;
  private lastProgressAt = 0;
  private lastRolloutMtime = 0;
  private currentStage: BridgeStage = "dispatched";
  private lastInfo: StageInfo | null = null;
  private turnStartAt = 0;

  constructor(options: TurnMonitorOptions) {
    this.options = resolveTurnMonitorOptions(options);
  }

  /** Begin watching. Sets the hard cap timer, the phase-0 timer (for
   * Codex-never-acks detection), and starts the rollout poll. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.turnStartAt = Date.now();
    this.lastProgressAt = this.turnStartAt;

    // Fire-and-Forget opts out of all timeouts - user explicitly asked
    // for "reply lands when it lands", so stall detection, hard cap,
    // and phase-0 "never activated" checks all go silent. Rollout
    // polling still runs because the stage-progress heartbeat is how
    // the status bar widget animates - only the failure-inducing
    // timers are disabled.
    if (!this.options.disableAllTimeouts) {
      this.timers.armHardCap(this.options.hardCapMs, () => {
        if (this.stopped) return;
        this.options.logger.warn(
          `[monitor] hard cap ${this.options.hardCapMs}ms exceeded - forcing interrupt`
        );
        this.options.onHardCap();
      });
      this.timers.armPhase0(this.options.phase0WindowMs, () => {
        if (this.stopped || this.currentStage !== "dispatched") return;
        this.options.logger.warn(
          `[monitor] phase 0 window ${this.options.phase0WindowMs}ms expired without task_started`
        );
        this.options.onStall("Codex never activated");
      });
    }

    // Always start polling. The first few ticks may find no rollout
    // path yet (Codex has not created the file), in which case
    // pollRollout no-ops and re-tries on the next tick. This matters
    // because the rollout is the only signal source for stages
    // working/writing/complete - eager-resolve-once-at-start would
    // strand the status bar at stage 2/5 if the file did not yet
    // exist when runTurnOnce dispatched.
    this.timers.startPolling(this.options.pollIntervalMs, () =>
      this.pollRollout()
    );

    this.armStallTimer();
  }

  /** Called by the dispatcher on every relevant JSON-RPC notification.
   * Any progress event resets the stall clock. `turn-started` also
   * advances stage to `received` even if the rollout poll has not
   * caught up yet. */
  observeRpcProgress(kind: RpcProgressKind): void {
    if (this.stopped) return;
    this.lastProgressAt = Date.now();
    if (kind === "turn-started" && this.currentStage === "dispatched") {
      this.advanceStageTo("received", this.lastInfo);
    }
    this.armStallTimer();
    // Fire onProgress even when no stage transition happened so the
    // dispatcher can refresh the heartbeat file. RPC-only activity
    // (mid-working delta stream) must keep channel.mjs awake.
    this.options.onProgress(this.currentStage, this.lastInfo ?? this.emptyInfo());
  }

  /** Explicit stage advance from the dispatcher - e.g. when
   * `turn/completed` fires or the caller decides to short-circuit.
   * Monitor will not regress below the supplied stage. */
  forceStage(stage: BridgeStage): void {
    if (this.stopped) return;
    this.advanceStageTo(stage, this.lastInfo);
  }

  /** Latest stage info snapshot, or null if no rollout read has
   * succeeded yet. Used by the dispatcher to write heartbeat files
   * on demand. */
  getSnapshot(): MonitorSnapshot | null {
    if (!this.lastInfo) return null;
    return {
      stage: this.currentStage,
      info: this.lastInfo,
      elapsedMs: Date.now() - this.turnStartAt,
    };
  }

  /** Stop watching. Idempotent. Clears every timer. Called by the
   * dispatcher in a `finally` at turn end regardless of outcome. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.timers.clearAll();
  }

  /** Read the rollout tail, run the phase parser, detect stage
   * advances and mtime freshness. Any fresh activity resets the
   * stall timer. */
  private pollRollout(): void {
    if (this.stopped) return;
    // Refresh the rollout path on every tick. Two reasons for the
    // re-ask, not just retry-until-first-success:
    //   1. First poll often returns null because Codex creates the
    //      rollout file slightly after thread/start returns.
    //   2. Compaction (thread/compact/start) or log rotation can
    //      swap the target file mid-turn while the old one still
    //      exists on disk. Pinning to the first resolved path would
    //      strand the monitor on a stale file that no longer receives
    //      new events.
    // The resolver is a cheap readdirSync walk - calling it every 5s
    // is negligible and keeps the monitor honest.
    const fresh = this.options.resolveRolloutPath();
    if (fresh !== this.resolvedRolloutPath) {
      if (fresh) {
        this.options.logger.info(
          `[monitor] rollout path ${this.resolvedRolloutPath ? "rotated" : "resolved"}: ${fresh}`
        );
        // Path changed - reset the mtime watermark so the first read
        // of the new file is treated as fresh progress regardless of
        // whether its mtime happens to be lower than the old file's.
        this.lastRolloutMtime = 0;
      }
      this.resolvedRolloutPath = fresh;
    }
    const path = this.resolvedRolloutPath;
    if (!path) return;

    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      // Path went away. Drop the cached path so next tick's re-ask
      // resolves cleanly when the replacement lands.
      this.resolvedRolloutPath = null;
      return;
    }

    const mtimeChanged = mtimeMs > this.lastRolloutMtime;
    this.lastRolloutMtime = mtimeMs;

    const tail = readTail(path);
    if (!tail) return;

    const info = parseStageInfo(tail);
    this.lastInfo = info;

    if (info.stage !== this.currentStage) {
      this.advanceStageTo(info.stage, info);
    }

    if (mtimeChanged) {
      this.lastProgressAt = Date.now();
      this.armStallTimer();
      // Rollout write (token_count, reasoning, function_call, etc.)
      // that did not advance the stage still signals Codex is alive.
      // Fire onProgress so the heartbeat file stays fresh.
      this.options.onProgress(this.currentStage, info);
    }
  }

  /** Monotonic stage advance with transition logging. Emits
   * onStageChange when the stage actually advances. Walks one step
   * at a time when the target skips stages, so each intermediate
   * stage fires its own callbacks. Important: on fast turns the RPC
   * `turn/completed` arrives before the 5s rollout poll can catch
   * final_answer, so `forceStage("complete")` is called while the
   * monitor is still at "working". Without sequential walking, the
   * writing stage would never get a callback and the walker-backed
   * widget would have to fill it in synthetically. Walking one step
   * at a time fires a heartbeat for writing first, then complete -
   * the widget's latch picks both up on its next read. */
  private advanceStageTo(target: BridgeStage, info: StageInfo | null): void {
    const currentIdx = BRIDGE_STAGE_ORDER.indexOf(this.currentStage);
    const targetIdx = BRIDGE_STAGE_ORDER.indexOf(target);
    if (targetIdx <= currentIdx) return;

    const effectiveInfo = info ?? this.emptyInfo();
    const tool = info?.activeTool ? ` tool=${info.activeTool.name}` : "";

    for (let i = currentIdx + 1; i <= targetIdx; i++) {
      const step = BRIDGE_STAGE_ORDER[i];
      this.currentStage = step;
      const elapsedMs = Date.now() - this.turnStartAt;
      this.options.logger.info(
        `[monitor] stage=${step} elapsed=${elapsedMs}ms${tool}`
      );
      this.options.onStageChange?.(step, effectiveInfo);
      this.options.onProgress(step, effectiveInfo);
    }
  }

  /** Refresh the stall timer. Called on any progress observation.
   * The timer fires after a tool-specific window with no further
   * progress, so each observation pushes the cut time forward. */
  private armStallTimer(): void {
    if (this.stopped) return;
    this.timers.clearStall();
    // Fire-and-Forget disables stall detection entirely.
    if (this.options.disableAllTimeouts) return;
    // Phase 0 has its own (tighter) timer - do not double-arm the
    // stall timer until we have crossed into phase 1+.
    if (this.currentStage === "dispatched") return;
    const window = stallWindowFor(
      this.lastInfo,
      this.options.stallWindowMs,
      this.options.stallFloorMs
    );
    this.timers.armStall(window, () => {
      if (this.stopped) return;
      const sinceProgress = Date.now() - this.lastProgressAt;
      const toolLabel = this.lastInfo?.activeTool?.name
        ? ` during ${this.lastInfo.activeTool.name}`
        : "";
      const reason = `Codex stalled${toolLabel} (${Math.round(sinceProgress / 1000)}s since last signal)`;
      this.options.logger.warn(`[monitor] ${reason}`);
      this.options.onStall(reason);
    });
  }

  private emptyInfo(): StageInfo {
    return {
      stage: this.currentStage,
      plan: null,
      activeTool: null,
      toolCallCount: 0,
      reasoningTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      inputTokens: 0,
      elapsedMs: Date.now() - this.turnStartAt,
    };
  }
}
