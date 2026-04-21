import { statSync } from "node:fs";
import { readTail } from "../shared/fs/fileReaders";
import { parseStageInfo } from "../shared/codex-rollout/phaseParser";
import type { BridgeStage, StageInfo } from "../shared/codex-rollout/types";
import type { EpicHandshakeLogger } from "./types";

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
 *   - Phase 1 onward: `stallWindowMs` since any progress signal.
 *     Timeout = soft fail ("Codex stalled during <tool>").
 *   - `hardCapMs`: absolute ceiling regardless of progress. Timeout
 *     = hard fail ("Codex exceeded max turn duration").
 *
 * Callers drive completion from outside. The monitor reports stall
 * or cap via `onStall` / `onHardCap`, and the caller sends
 * `turn/interrupt` + writes the error envelope. Successful turn
 * completion is the caller's responsibility (turn/completed RPC or
 * rollout task_complete); the monitor just stops when `stop()` is
 * invoked.
 */

export interface TurnMonitorOptions {
  /** Resolver for the bridge thread's rollout .jsonl path. Called on
   * every poll tick until it returns a non-null path, then on every
   * subsequent tick to keep the path fresh (Codex may rotate files
   * mid-turn for compaction). The dispatcher passes a thunk that wraps
   * `findRolloutPath(threadId)` so the monitor can keep retrying while
   * Codex is still creating the file - prior eager-resolution-at-start
   * left the monitor permanently in RPC-only mode if the file did not
   * exist at dispatch time, which stranded the status-bar glyph at
   * stage 2/5 because nothing else advances `working` / `writing`.
   *
   * Pass a thunk that always returns null to disable rollout polling
   * (RPC-only mode). */
  resolveRolloutPath: () => string | null;
  /** Fires on every observed progress signal - stage transition,
   * RPC notification, OR rollout mtime bump. Used by the dispatcher
   * to refresh the heartbeat file so channel.mjs's adaptive polling
   * window keeps extending while Codex is demonstrably working.
   * Without this, a long `working` phase would emit plenty of
   * `function_call` + `token_count` events that reset the monitor's
   * stall clock but never refresh the heartbeat, so channel.mjs
   * would bail at `initialDeadline + stallWindow`. */
  onProgress: (stage: BridgeStage, info: StageInfo) => void;
  /** Fires whenever the monitor advances to a later stage. UI uses
   * this to log the transition. onProgress also fires on every
   * transition so callers don't need to subscribe to both if they
   * only care about "did anything happen" semantics. */
  onStageChange?: (stage: BridgeStage, info: StageInfo) => void;
  /** Fires when the stall window expires with no progress signal. */
  onStall: (reason: string) => void;
  /** Fires when `hardCapMs` elapses regardless of progress. */
  onHardCap: () => void;
  /** Logger for phase transitions + timing. Prefixes each line with
   * `[monitor]` so it is filterable in the output channel. */
  logger: EpicHandshakeLogger;
  /** Milliseconds to wait for the first `task_started` / `turn/started`
   * before declaring the turn dead. Default 20_000. */
  phase0WindowMs?: number;
  /** Default milliseconds since the most recent progress signal before
   * the turn is declared stalled. Default 60_000. Per-activity windows
   * override this when an `activeTool` is present (see
   * `stallWindowForTool`) - 60s is too tight for a `shell_command` that
   * runs `npm test` or similar, because Codex emits function_call at
   * dispatch time then goes silent until function_call_output lands.
   * Raising the default here instead would also loosen idle-phase
   * stall detection, which we want to keep tight. */
  stallWindowMs?: number;
  /** Absolute wall-clock ceiling. Default 300_000 (5 min). */
  hardCapMs?: number;
  /** How often to stat + tail the rollout file. Default 5_000. */
  pollIntervalMs?: number;
}

/** Kind of RPC progress event observed. Drives the stall-reset path
 * without coupling the monitor to the JSON-RPC client type. */
export type RpcProgressKind =
  | "turn-started"
  | "item-started"
  | "delta"
  | "item-completed";

interface MonitorSnapshot {
  stage: BridgeStage;
  info: StageInfo;
  elapsedMs: number;
}

export class TurnMonitor {
  private readonly options: Required<
    Omit<
      TurnMonitorOptions,
      | "resolveRolloutPath"
      | "onProgress"
      | "onStageChange"
      | "onStall"
      | "onHardCap"
      | "logger"
    >
  > &
    Pick<
      TurnMonitorOptions,
      | "resolveRolloutPath"
      | "onProgress"
      | "onStageChange"
      | "onStall"
      | "onHardCap"
      | "logger"
    >;
  private resolvedRolloutPath: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private hardCapTimer: ReturnType<typeof setTimeout> | null = null;
  private phase0Timer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  private lastProgressAt = 0;
  private lastRolloutMtime = 0;
  private currentStage: BridgeStage = "dispatched";
  private lastInfo: StageInfo | null = null;
  private turnStartAt = 0;

  constructor(options: TurnMonitorOptions) {
    this.options = {
      resolveRolloutPath: options.resolveRolloutPath,
      onProgress: options.onProgress,
      onStageChange: options.onStageChange,
      onStall: options.onStall,
      onHardCap: options.onHardCap,
      logger: options.logger,
      phase0WindowMs: options.phase0WindowMs ?? 20_000,
      stallWindowMs: options.stallWindowMs ?? 60_000,
      hardCapMs: options.hardCapMs ?? 300_000,
      pollIntervalMs: options.pollIntervalMs ?? 5_000,
    };
  }

  /** Begin watching. Sets the hard cap timer, the phase-0 timer (for
   * Codex-never-acks detection), and starts the rollout poll. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.turnStartAt = Date.now();
    this.lastProgressAt = this.turnStartAt;

    this.hardCapTimer = setTimeout(() => {
      this.hardCapTimer = null;
      if (this.stopped) return;
      this.options.logger.warn(
        `[monitor] hard cap ${this.options.hardCapMs}ms exceeded - forcing interrupt`
      );
      this.options.onHardCap();
    }, this.options.hardCapMs);

    this.phase0Timer = setTimeout(() => {
      this.phase0Timer = null;
      if (this.stopped) return;
      if (this.currentStage === "dispatched") {
        this.options.logger.warn(
          `[monitor] phase 0 window ${this.options.phase0WindowMs}ms expired without task_started`
        );
        this.options.onStall("Codex never activated");
      }
    }, this.options.phase0WindowMs);

    // Always start polling. The first few ticks may find no rollout
    // path yet (Codex has not created the file), in which case
    // pollRollout no-ops and re-tries on the next tick. This matters
    // because the rollout is the only signal source for stages
    // working/writing/complete - eager-resolve-once-at-start would
    // strand the status bar at stage 2/5 if the file did not yet
    // exist when runTurnOnce dispatched.
    this.pollTimer = setInterval(
      () => this.pollRollout(),
      this.options.pollIntervalMs
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
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.hardCapTimer) {
      clearTimeout(this.hardCapTimer);
      this.hardCapTimer = null;
    }
    if (this.phase0Timer) {
      clearTimeout(this.phase0Timer);
      this.phase0Timer = null;
    }
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  // --- Internals ---

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
    // The resolver is a cheap readdirSync walk; calling it every 5s
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
    const order: BridgeStage[] = [
      "dispatched",
      "received",
      "working",
      "writing",
      "complete",
    ];
    const currentIdx = order.indexOf(this.currentStage);
    const targetIdx = order.indexOf(target);
    if (targetIdx <= currentIdx) return;

    const effectiveInfo = info ?? this.emptyInfo();
    const tool = info?.activeTool ? ` tool=${info.activeTool.name}` : "";

    for (let i = currentIdx + 1; i <= targetIdx; i++) {
      const step = order[i];
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
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    // Phase 0 has its own (tighter) timer; do not double-arm the
    // stall timer until we have crossed into phase 1+.
    if (this.currentStage === "dispatched") return;
    const window = this.stallWindowForCurrentActivity();
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.stopped) return;
      const sinceProgress = Date.now() - this.lastProgressAt;
      const toolLabel = this.lastInfo?.activeTool?.name
        ? ` during ${this.lastInfo.activeTool.name}`
        : "";
      const reason = `Codex stalled${toolLabel} (${Math.round(sinceProgress / 1000)}s since last signal)`;
      this.options.logger.warn(`[monitor] ${reason}`);
      this.options.onStall(reason);
    }, window);
  }

  /** Pick the stall window based on the active tool. `shell_command`
   * can run several minutes with no rollout writes (Codex emits the
   * function_call entry at dispatch, then nothing until
   * function_call_output lands). Long-running reasoning is similar.
   * Quick tools (update_plan, read_file) stay on tighter windows so
   * a true stall still gets caught. Falls back to the configured
   * default when no active tool is set (pure-reasoning phase or
   * between tool calls). */
  private stallWindowForCurrentActivity(): number {
    const tool = this.lastInfo?.activeTool?.name;
    if (!tool) {
      // Reasoning-only phases can run long (model thinking without
      // tool calls); reasoning is signalled by reasoningTokens > 0
      // on the last parsed info snapshot.
      if (this.lastInfo && this.lastInfo.reasoningTokens > 0) {
        return 180_000;
      }
      return this.options.stallWindowMs;
    }
    switch (tool) {
      case "shell_command":
        return 180_000;
      case "web_search":
      case "web_search_call":
        return 120_000;
      case "update_plan":
      case "read_file":
        return 60_000;
      default:
        return Math.max(this.options.stallWindowMs, 90_000);
    }
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
