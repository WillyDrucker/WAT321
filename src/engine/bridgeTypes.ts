/**
 * Type-only definitions for the Epic Handshake bridge state surface.
 * Lives in the engine layer so eventHub's `bridge.*` event payloads can
 * reference these names without importing from the EH tool tier (which
 * would invert the dependency graph).
 *
 * The concrete `BridgeStageCoordinator` class lives under
 * `WAT321_EPIC_HANDSHAKE/` because bridge state is single-tool, not
 * cross-cutting. Engine owns only the type contract + event surface;
 * the EH tier owns the implementation and lifecycle.
 */

export type BridgePhase =
  | "idle"
  | "pre-ceremony"
  | "ceremony"
  | "stage";

export type BridgeStage =
  | "dispatched"
  | "received"
  | "working"
  | "writing"
  | "complete";

/** Minimal heartbeat info the snapshot exposes. The full `TurnHeartbeat`
 * type lives inside the EH tier; status-bar widgets only need
 * `turnStartedAt` to compute ceremony elapsed-since-start plus
 * `target` to suppress their debug ceremony on off-target dispatches,
 * so the structural subset stays in engine and the wider type stays
 * where its fields are produced. */
export interface BridgeHeartbeatInfo {
  turnStartedAt?: number;
  /** Backend producing this heartbeat. Lets a session-tokens widget
   * filter ceremony / stage-driven animations to its own provider so
   * the Codex widget stops playing `debug-disconnect`/`debug-connected`
   * during a non-Codex (Big Pickle / Local LLM) dispatch. Optional for
   * legacy heartbeat files that pre-date the unified writer. */
  target?: "codex" | "opencode" | "local";
}

/** Active wait mode at snapshot time. Drives downstream widget
 * behavior that depends on whether Claude's MCP call is blocked
 * waiting for the bridge reply (`adaptive` / `standard`) or already
 * returned (`fire-and-forget`). Surfaced through the bridge stage
 * snapshot so widgets in shared/ui don't have to import from the
 * EH tier to read it. */
export type BridgeWaitMode = "standard" | "adaptive" | "fire-and-forget";

/** Codex per-turn effort override (workspace-scoped). Null means
 * "no override set" - Codex falls back to the model's
 * `default_reasoning_level`. Surfaced through the snapshot so the
 * Codex session-tokens tooltip can render the effective effort
 * without importing from the EH tier. */
export type CodexEffortOverride = "low" | "medium" | "high" | "xhigh" | null;

/** Wait-budget surface for the in-flight bridge dispatch. Populated
 * when `channel.mjs` is blocking on a Codex reply. The Claude session-
 * tokens tooltip reads `timeoutSec` to render a "Waiting on Codex: Ns"
 * line so the user knows how long Claude will hold for. `mode`
 * distinguishes sync (fixed budget) from adaptive (extends while the
 * dispatcher heartbeat stays fresh) so the tooltip can render the
 * right wait shape. Null when no wait is in flight. */
export interface BridgeWaitInfo {
  target: "codex";
  timeoutSec: number;
  startedAt: number;
  mode: "sync" | "adaptive";
}

export interface BridgeStageSnapshot {
  workspacePath: string | null;
  phase: BridgePhase;
  latchedStage: BridgeStage | null;
  msInStage: number;
  ceremonyActive: boolean;
  returning: boolean;
  paused: boolean;
  heartbeat: BridgeHeartbeatInfo | null;
  waitMode: BridgeWaitMode;
  codexEffort: CodexEffortOverride;
  /** Active wait info when Claude is currently blocking on a Codex
   * reply. Lets the Claude session-tokens tooltip surface the wait
   * budget. Null when idle, fire-and-forget, or otherwise not blocking. */
  waitInfo: BridgeWaitInfo | null;
}

/** Reader contract widgets consume. Implemented by the EH-tier
 * `BridgeStageCoordinator`. Status-bar widgets in shared/ui depend on
 * this interface, never on the concrete class, so the shared layer
 * does not import from a tool tier. */
export interface BridgeStageReader {
  snapshot(): BridgeStageSnapshot;
  /** Subscribe to phase + stage transitions. Widgets that gate their
   * own animation ticker on bridge state need this push signal because
   * they only re-evaluate `animationsActive()` inside their `update()`
   * path, which fires on the underlying service's poll cadence (15s).
   * Without a push, the very first bridge dispatch after a cold launch
   * lands between service polls and the widget never starts ticking
   * for the ceremony / stage walk. Returns a disposer. */
  onChange(handler: () => void): { dispose(): void };
}
