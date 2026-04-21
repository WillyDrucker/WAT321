/**
 * Shared types for Codex rollout phase parsing. Used by:
 *   - `CodexSessionTokenService` for tooltip richness (current tool,
 *     plan progress, reasoning/output split)
 *   - `CodexDispatcher` + `TurnMonitor` for bridge adaptive timeout
 *
 * Parser lives in `phaseParser.ts` as pure string -> struct logic; no
 * watchers, no state. Both consumers read their own rollout file and
 * call the parser on the tail buffer they already have.
 *
 * Canonical 5-stage sequence. Monotonically advances; a turn cannot
 * regress to an earlier stage. Drives both the progress fraction in
 * the status bar and the Adaptive dispatcher's budget windows.
 */

/** Canonical Epic Handshake turn stage. */
export type BridgeStage =
  /** Envelope written to `inbox/codex/`, dispatcher has not yet acked. */
  | "dispatched"
  /** `task_started` seen in rollout OR `turn/started` RPC notification. */
  | "received"
  /** Any `function_call` OR `reasoning` event observed in rollout. */
  | "working"
  /** `agent_message phase=final_answer` observed in rollout. */
  | "writing"
  /** `task_complete` in rollout OR `turn/completed` RPC notification. */
  | "complete";

/** Single step in Codex's native `update_plan` function call. */
export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

/** Snapshot of the most recent `update_plan` invocation. Codex emits
 * this as a structured progress protocol when a task warrants
 * multi-step planning. Short single-step asks will skip it. */
export interface PlanState {
  steps: readonly PlanStep[];
  /** Index of the first `in_progress` step, or -1 when all done / none started. */
  currentIndex: number;
  totalSteps: number;
}

/** One Codex tool invocation in the rollout. Pairs with a matching
 * `function_call_output` via `callId` once complete. */
export interface ToolCall {
  name: string;
  callId: string;
  /** ISO timestamp from the rollout entry. */
  timestamp: string;
  /** First ~200 chars of the arguments JSON string, for tooltip display. */
  argumentsPreview: string;
  /** True iff a matching `function_call_output` has been seen. */
  completed: boolean;
}

/** Rendered display for the status bar + tooltip. Computed from
 * `StageInfo` via `renderStageDisplay()`. Keeping the render layer
 * separate from the parse layer keeps the parser pure and lets UI
 * label rules evolve without re-reading the tail. */
export interface StageDisplay {
  /** Fraction for the status bar (always N/5). Monotonic; never regresses. */
  fraction: string;
  /** Human-readable short label. Context-aware at stage 3/5 - pulled
   * from the active tool name or reasoning presence. */
  label: string;
  /** Optional tooltip line: text of the currently-`in_progress` plan
   * step when Codex has emitted an `update_plan` call. Null when no
   * plan is active. */
  planLine: string | null;
  /** Optional tooltip line: active tool name + elapsed. Null when no
   * tool is in flight. */
  toolLine: string | null;
}

/** Composite snapshot of a turn in progress. All fields are derived
 * from a single tail read; no I/O side effects. Fields that have no
 * signal in the tail are null / 0. */
export interface StageInfo {
  stage: BridgeStage;
  /** Present iff Codex emitted at least one `update_plan` call. */
  plan: PlanState | null;
  /** Most recent tool call that has not yet completed, or null. */
  activeTool: ToolCall | null;
  /** Total tool calls since `task_started`. */
  toolCallCount: number;
  /** Latest `token_count.info.last_token_usage.reasoning_output_tokens`. */
  reasoningTokens: number;
  /** Latest `token_count.info.last_token_usage.output_tokens`. */
  outputTokens: number;
  /** Latest `token_count.info.last_token_usage.cached_input_tokens`. */
  cachedInputTokens: number;
  /** Latest `token_count.info.last_token_usage.input_tokens`. */
  inputTokens: number;
  /** Milliseconds since `task_started`. 0 when stage is `dispatched`. */
  elapsedMs: number;
}
