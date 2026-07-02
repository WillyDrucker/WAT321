import type { Envelope, EnvelopeTarget } from "../inbox/envelope";

/**
 * Shared contracts for backend dispatchers. Codex (Epic Handshake) and
 * OpenCode both implement these so the engine-side outbound watcher
 * and graceful-shutdown logic can drive either tier without
 * per-target switches.
 *
 * Per-tier concerns (managing the `codex app-server` subprocess,
 * running the SSE poll loop for OpenCode, etc.) stay inside the tier
 * module. The contract here is just "given an outbound envelope, run
 * the turn and write a reply envelope when done."
 */

/** What the outbound watcher hands off to the tier's run-turn
 * implementation. The tier returns the body (and optional error
 * marker) for the inbound envelope the watcher should write. */
export interface DispatchRequest {
  envelope: Envelope;
  /** Workspace path the dispatch belongs to. Tier writes its inbound
   * envelope under the same workspace's inbox dir. */
  workspacePath: string | null;
  /** Abort signal triggered when the extension is shutting down or
   * the user cancelled. Tier should propagate to the HTTP client /
   * subprocess so in-flight work stops promptly. */
  signal: AbortSignal;
}

export interface DispatchResult {
  /** Reply body to write into the inbound envelope. */
  body: string;
  /** True when the dispatch errored. The inbound envelope is still
   * written so the user gets *some* feedback - the body should contain
   * a human-readable error message. */
  error?: boolean;
  /** Optional alias override for the inbound envelope. Lets tiers
   * surface (e.g.) the actual model that handled the request when it
   * differs from the alias passed in. */
  alias?: string;
}

/** A tier's run-turn implementation. Signature is intentionally small
 * so future backends only need one entry point. Long-running work
 * inside should respect `request.signal` so graceful shutdown can
 * abort cleanly. */
export type DispatchHandler = (
  request: DispatchRequest
) => Promise<DispatchResult>;

/** Minimum surface a tier dispatcher exposes to the engine. Adding a
 * new backend means implementing one of these and registering it. */
export interface BackendDispatcher {
  /** Which target this dispatcher handles. Used by the engine to
   * route outbound envelopes to the right run-turn implementation. */
  readonly target: EnvelopeTarget;
  /** Whether the dispatcher is currently accepting new envelopes.
   * Set false during shutdown so the outbound watcher stops handing
   * off work mid-tear-down. */
  isAccepting(): boolean;
  /** Run a single dispatch end-to-end. The engine's outbound watcher
   * calls this on every new outbound envelope. */
  run(request: DispatchRequest): Promise<DispatchResult>;
  /** Begin graceful shutdown. Aborts in-flight dispatches via their
   * signals and stops accepting new work. The engine awaits this
   * during extension deactivate. Tier-specific cleanup (subprocess
   * teardown, HTTP pool drain) lives in the implementation. */
  shutdown(): Promise<void>;
}
