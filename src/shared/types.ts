import type * as vscode from "vscode";

/**
 * Generic service state machine for anything that polls an external source
 * and can end up in loading / not-connected / no-auth / token-expired /
 * rate-limited / offline / error / ok states. The success payload is
 * provider-specific (TData); everything else is shared.
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
