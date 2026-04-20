/**
 * Minimal logger interface used by the JSON-RPC client, dispatcher,
 * and installer. Dependency-free (no `vscode` import) so tests can
 * inject a console or array-backed implementation; the extension
 * wires a VS Code output channel via `outputChannel.ts`.
 *
 * This is the one place in WAT321 where debug logging is allowed.
 * A child process plus event stream is materially harder to debug
 * than the pure-pull usage widgets, so a focused channel is worth
 * the footprint. Call sites stay strictly limited.
 */
export interface EpicHandshakeLogger {
  /** Lifecycle / state transition events. */
  info(message: string): void;
  /** Expected recoverable conditions (retry, crash-and-respawn). */
  warn(message: string): void;
  /** Unexpected failures that need attention. */
  error(message: string): void;
}
