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
 * `turnStartedAt` to compute ceremony elapsed-since-start, so the
 * structural subset stays in engine and the wider type stays where its
 * fields are produced. */
export interface BridgeHeartbeatInfo {
  turnStartedAt?: number;
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
