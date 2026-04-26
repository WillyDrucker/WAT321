import type * as vscode from "vscode";

/**
 * Generic state-machine types every poller surfaces, plus the listener
 * and status-bar-widget contracts they hand to subscribers. Lives in
 * the engine layer so any future engine-tier consumer can subscribe to
 * service state without inverting the dependency graph through `shared/`.
 *
 * The success payload is provider-specific (`TData`); everything else
 * is shared shape. Tools and shared helpers import these here too -
 * the engine is the single source of truth for the contract.
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
      /** Optional friendlier reason string extracted from the
       * server's 429 response body (Anthropic returns a JSON error
       * shape; Codex returns plain text). Displayed as an extra
       * line in the rate-limited tooltip when present. Absent if
       * the body was unparseable or empty. */
      serverMessage?: string;
      /** True when the park was entered without recent session
       * activity - Anthropic's usage endpoint 429s cold polls on
       * accounts with no recent OAuth use, which is not a real
       * rate-limit incident. Frozen at park time so a user who
       * hits a real limit and then idles does not flip to the
       * friendly skin. The renderer uses this to distinguish
       * "idle / needs first activity" from "actively rate-limited". */
      isColdStart?: boolean;
    }
  | { status: "offline"; message: string }
  | { status: "error"; message: string }
  | { status: "ok"; data: TData; fetchedAt: number };

/** Generic listener callback for service state changes. */
export type StateListener<TState> = (state: TState) => void;

/**
 * Status bar widget contract. All widgets accept a state value and render
 * it. TState is usually a ServiceState<TData> for usage widgets or a
 * SessionTokenState for the session token widgets.
 */
export interface StatusBarWidget<TState> extends vscode.Disposable {
  update(state: TState): void;
}
