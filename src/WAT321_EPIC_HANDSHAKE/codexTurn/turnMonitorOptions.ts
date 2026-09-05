import type { StageInfo } from "../../shared/codex-rollout/turnStageTypes";
import type { EpicHandshakeLogger } from "../epicHandshakeLogger";
import type { BridgeStage } from "../../engine/bridgeTypes";

/**
 * Options + types for `TurnMonitor`. The interface stays in its own
 * file because the field docs are load-bearing (each describes a
 * timeout policy or callback contract) and would dominate the main
 * monitor file otherwise. `resolveTurnMonitorOptions` applies the
 * defaults so the class constructor is one assignment instead of a
 * 15-line ternary chain.
 */

export interface TurnMonitorOptions {
  /** Resolver for the bridge thread's rollout .jsonl path. Called on
   * every poll tick until it returns a non-null path, then on every
   * subsequent tick to keep the path fresh (Codex may rotate files
   * mid-turn for compaction). The dispatcher passes a thunk that
   * wraps `findRolloutPath(threadId)` so the monitor can keep
   * retrying while Codex is still creating the file - prior eager-
   * resolution-at-start left the monitor permanently in RPC-only
   * mode if the file did not exist at dispatch time, which stranded
   * the status-bar glyph at stage 2/5 because nothing else advances
   * `working` / `writing`.
   *
   * Pass a thunk that always returns null to disable rollout polling
   * (RPC-only mode). */
  resolveRolloutPath: () => string | null;
  /** Fires on every observed progress signal - stage transition, RPC
   * notification, OR rollout mtime bump. Used by the dispatcher to
   * refresh the heartbeat file so channel.mjs's adaptive polling
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
  /** Default ms since the most recent progress signal before the
   * turn is declared stalled. Default 60_000. Per-activity windows
   * override this when an `activeTool` is present (see
   * `stallWindowFor`) - 60s is too tight for a `shell_command` that
   * runs `npm test`, because Codex emits function_call at dispatch
   * then goes silent until function_call_output lands. Raising the
   * default here instead would also loosen idle-phase stall
   * detection, which we want to keep tight. */
  stallWindowMs?: number;
  /** Absolute wall-clock ceiling. Default 300_000 (5 min). */
  hardCapMs?: number;
  /** How often to stat + tail the rollout file. Default 5_000. */
  pollIntervalMs?: number;
  /** Minimum stall window applied on top of the per-tool values. When
   * set, every tool window gets max()'d with this floor - useful for
   * modes that should tolerate longer silent gaps (e.g. Adaptive).
   * Default 0 (no floor). */
  stallFloorMs?: number;
  /** Disable stall detection, hard-cap, and phase-0 "never activated"
   * checks entirely. For Fire-and-Forget, where the user explicitly
   * opted out of waiting - letting Codex run as long as it needs is
   * the whole point. The reply lands when it lands - if Codex truly
   * hangs the user can cancel from the widget or reset the session.
   * Default false. */
  disableAllTimeouts?: boolean;
}

/** Kind of RPC progress event observed. Drives the stall-reset path
 * without coupling the monitor to the JSON-RPC client type. */
export type RpcProgressKind =
  | "turn-started"
  | "item-started"
  | "delta"
  | "item-completed";

export interface MonitorSnapshot {
  stage: BridgeStage;
  info: StageInfo;
  elapsedMs: number;
}

/** Options after defaults have been applied. The class holds one of
 * these as `this.options` so every method can read numbers / flags
 * directly without `??` fallbacks at every site. */
export interface ResolvedTurnMonitorOptions {
  resolveRolloutPath: () => string | null;
  onProgress: (stage: BridgeStage, info: StageInfo) => void;
  onStageChange?: (stage: BridgeStage, info: StageInfo) => void;
  onStall: (reason: string) => void;
  onHardCap: () => void;
  logger: EpicHandshakeLogger;
  phase0WindowMs: number;
  stallWindowMs: number;
  hardCapMs: number;
  pollIntervalMs: number;
  stallFloorMs: number;
  disableAllTimeouts: boolean;
}

export function resolveTurnMonitorOptions(
  opts: TurnMonitorOptions
): ResolvedTurnMonitorOptions {
  return {
    resolveRolloutPath: opts.resolveRolloutPath,
    onProgress: opts.onProgress,
    onStageChange: opts.onStageChange,
    onStall: opts.onStall,
    onHardCap: opts.onHardCap,
    logger: opts.logger,
    phase0WindowMs: opts.phase0WindowMs ?? 20_000,
    stallWindowMs: opts.stallWindowMs ?? 60_000,
    hardCapMs: opts.hardCapMs ?? 300_000,
    pollIntervalMs: opts.pollIntervalMs ?? 5_000,
    stallFloorMs: opts.stallFloorMs ?? 0,
    disableAllTimeouts: opts.disableAllTimeouts ?? false,
  };
}
