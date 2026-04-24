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
  /** Reveal the underlying output channel in the VS Code Output panel.
   * Used by diagnostic UI paths (Delete All "(0) - View details",
   * Repair picker Force Repair, etc.) to surface the scan breakdown
   * a user just logged. No-op if the logger is backed by a non-VS
   * Code implementation (test doubles). */
  show(): void;
}
