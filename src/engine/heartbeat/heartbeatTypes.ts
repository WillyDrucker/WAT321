import type { EnvelopeTarget, EnvelopeWaitMode } from "../inbox/envelope";

/**
 * Unified heartbeat shape every backend dispatcher writes during a
 * long-running turn. Drives:
 *   - The bridge stage coordinator (Codex 5-stage glyph animation).
 *   - The Claude session-tokens widget animation gate (FF bypasses
 *     the ceremony but adaptive / sync keep the icon spinning while
 *     the dispatcher keeps writing).
 *   - The MCP server's adaptive wait logic (the wait extends while
 *     `lastProgressAt` is fresh, aborts when stale).
 *
 * The shape is a superset:
 *   - Codex populates every field (5-stage walk + per-tool counts).
 *   - OpenCode / Local emit a simpler heartbeat with `stage: "working"`
 *     plus refreshing `lastProgressAt`. They have no per-stage notion
 *     because their SSE event stream doesn't map onto Codex's stage
 *     model.
 */

export type HeartbeatStage =
  | "dispatched"
  | "received"
  | "working"
  | "writing"
  | "complete";

export interface Heartbeat {
  /** Outbound envelope id this heartbeat belongs to. Filename is
   * `turn-heartbeat.<dispatchId>.json`. */
  dispatchId: string;
  /** Backend producing the heartbeat. */
  target: EnvelopeTarget;
  /** Workspace path so readers can filter to the active window. */
  workspacePath: string;
  /** Workspace hash mirror of workspacePath for filtering callers
   * that already have the hash. Computed by the writer. */
  workspaceHash: string;
  /** Coarse stage label. Codex walks all 5; non-Codex backends pin to
   * `working` for the duration. */
  stage: HeartbeatStage;
  /** Codex: name of the tool the current stage is executing. Null
   * otherwise (between stages, or non-Codex). */
  activeTool: string | null;
  /** Codex: count of tool calls in this turn. 0 for non-Codex. */
  toolCallCount: number;
  /** Wall-clock ms since turn start. The widget renders this as the
   * "wait time" counter that ticks up regardless of stage. */
  elapsedMs: number;
  /** ms-epoch of the last progress signal. Adaptive aborts when
   * `Date.now() - lastProgressAt > ADAPTIVE_STALE_MS`. */
  lastProgressAt: number;
  /** Wall-clock start of the turn so consumers can compute
   * "ms-since-start" against `Date.now()` directly. */
  turnStartedAt?: number;
  /** Per-stage first-entered timestamps. Codex populates each as the
   * dispatcher walks stages; missing keys = stage not yet reached. */
  stageEnteredAt?: Partial<Record<HeartbeatStage, number>>;
  /** Wait mode this dispatch is running under. Surfaced on the
   * heartbeat so widget gates and MCP-side adaptive logic see the
   * same value the dispatcher resolved. Absent = fall back to the
   * sticky flag (legacy path). */
  waitMode?: EnvelopeWaitMode;
}
