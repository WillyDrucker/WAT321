import * as vscode from "vscode";

/**
 * Generic service state machine for anything that polls an external source
 * and can end up in loading / not-connected / authed / rate-limited / error
 * states. The success payload is provider-specific (TData); everything else
 * is shared.
 */
export type ServiceState<TData> =
  | { status: "loading" }
  | { status: "not-connected" }
  | { status: "no-auth" }
  | { status: "token-expired"; message: string }
  | {
      status: "rate-limited";
      retryAfterMs: number;
      rateLimitedAt: number;
      /** Distinguishes a server-directed backoff (Retry-After header
       * present) from our own hardcoded 15-minute fallback. The widget
       * exposes a click-to-wake affordance ONLY when source is
       * "fallback" - we never override a wait the server explicitly
       * asked for. */
      source: "fallback" | "server";
    }
  | { status: "offline"; message: string }
  | { status: "error"; message: string }
  | { status: "ok"; data: TData; fetchedAt: number };

/**
 * Status bar widget contract. All widgets accept a state value and render
 * it. TState is usually a ServiceState<TData> for usage widgets or a
 * SessionTokenState for the session token widgets.
 */
export interface StatusBarWidget<TState> extends vscode.Disposable {
  update(state: TState): void;
}
