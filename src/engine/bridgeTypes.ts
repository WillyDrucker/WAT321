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
  | "stage"
  | "returning"
  | "delivered";

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

export interface BridgeStageSnapshot {
  workspacePath: string | null;
  phase: BridgePhase;
  latchedStage: BridgeStage | null;
  msInStage: number;
  ceremonyActive: boolean;
  returning: boolean;
  paused: boolean;
  heartbeat: BridgeHeartbeatInfo | null;
}

/** Reader contract widgets consume. Implemented by the EH-tier
 * `BridgeStageCoordinator`. Status-bar widgets in shared/ui depend on
 * this interface, never on the concrete class, so the shared layer
 * does not import from a tool tier. */
export interface BridgeStageReader {
  snapshot(): BridgeStageSnapshot;
}
