/**
 * Typed bindings for the `codex app-server` JSON-RPC 2.0 protocol.
 *
 * Reference: https://developers.openai.com/codex/app-server and the
 * Rust source in `openai/codex/codex-rs/app-server-protocol/`. Only
 * the methods and notifications Epic Handshake actually uses are
 * bound here:
 *
 *   Requests:
 *     - initialize          - handshake at connection start
 *     - thread/start        - create a fresh Bridge thread
 *     - thread/resume       - resume a persisted thread by id
 *     - thread/name/set     - stamp a display name for the TUI picker
 *     - thread/compact/start - in-place compact on context exceeded
 *     - turn/start          - dispatch a Bridge message as a turn
 *     - turn/interrupt      - cancel an in-flight turn
 *
 *   Notifications (server to client):
 *     - item/agentMessage/delta  (streamed assistant content)
 *     - turn/completed           (terminal for a turn)
 *
 * Method and notification names are passed as string literals at call
 * sites to keep the protocol surface honest: what the dispatcher
 * actually sends is what you see. Request param types are typed
 * strictly so TypeScript enforces correctness on the wire shape.
 * Results are typed as `unknown` - callers do their own runtime shape
 * check. This insulates us from minor server-side schema changes: if
 * Codex adds a field, our code keeps working; if a field we rely on
 * goes missing, the runtime check fails loud at exactly the call site
 * that cares.
 */

// -----------------------------------------------------------------------
// JSON-RPC 2.0 envelopes
// -----------------------------------------------------------------------

export const JSONRPC_VERSION = "2.0";

/** A JSON-RPC 2.0 request envelope sent from client to server. */
export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: TParams;
}

/** A JSON-RPC 2.0 successful response. */
export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: "2.0";
  id: number;
  result: TResult;
}

/** A JSON-RPC 2.0 error response. The `data` field is protocol-
 * specific; we treat it as unknown and let callers inspect. */
export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** A JSON-RPC 2.0 notification (server-to-client, no id). */
export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: "2.0";
  method: string;
  params: TParams;
}

/** Either-variant response from the server. Clients inspect `error`
 * vs `result` to tell them apart. */
export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse;

// -----------------------------------------------------------------------
// Request param types for the methods Epic Handshake uses
// -----------------------------------------------------------------------

/** Sandbox policy values Codex's app-server accepts. Defines what
 * the bridge's Codex session is allowed to do at the OS level. Same
 * values as the Codex CLI's `--sandbox` flag. */
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

/** Approval policy values. Controls when Codex pauses to ask for
 * permission. `never` is what Bridge needs (we cannot present
 * prompts back to the user mid-turn). The other values exist on the
 * Codex CLI but are not useful from the bridge's blocking-call
 * shape. */
export type CodexApprovalPolicy =
  | "never"
  | "untrusted"
  | "on-failure"
  | "on-request";

/** `thread/start` params. Creates a fresh Bridge thread owned by
 * this client. Defaults are `approvalPolicy: "never"` and
 * `sandbox: "read-only"` (safest), overridable via the
 * `wat321.epicHandshake.codexSandbox` and
 * `wat321.epicHandshake.codexApprovalPolicy` settings.
 * `sessionStartSource` is echoed into the rollout metadata and
 * helps distinguish bridge-spawned sessions from user-spawned ones
 * when inspecting history. */
export interface ThreadStartParams {
  clientInfo?: {
    name: string;
  };
  /** Working directory hint. Used as the Codex session cwd so
   * rollout files land alongside the user's workspace-scoped
   * sessions instead of in a stray tmpdir. */
  cwd?: string;
  /** Optional model override. Omit to use the user's default. */
  model?: string;
  approvalPolicy?: CodexApprovalPolicy | string;
  sandbox?: CodexSandbox | string;
  /** Source tag echoed into session metadata. Bridge uses `"startup"`. */
  sessionStartSource?: string;
}

/** Sandbox policy object shape accepted by `turn/start`. Casing here
 * is DIFFERENT from the `thread/start` `sandbox` string parameter:
 *   - `thread/start.sandbox` → kebab string (`"read-only"`, `"danger-full-access"`)
 *   - `turn/start.sandboxPolicy.type` → camelCase (`"readOnly"`, `"dangerFullAccess"`)
 * Both casings are native to the app-server's Rust source. Do not
 * try to unify - the server rejects the wrong casing at the wrong
 * layer. */
export type TurnSandboxPolicy =
  | { type: "readOnly" }
  | { type: "workspaceWrite" }
  | { type: "dangerFullAccess" };

/** `turn/start` params. Begins a new turn with the given input.
 * `approvalPolicy` is always `"never"` - the bridge has no UI to
 * relay Codex's approval prompts back mid-turn. `sandboxPolicy` is
 * read from the `codex-full-access.flag` sentinel at every turn,
 * so toggling permissions in the sessions submenu takes effect on
 * the next prompt without needing a thread reset. */
export interface TurnStartParams {
  threadId: string;
  /** Input content. We send a single text block constructed from
   * the Bridge message body plus a compact header listing the
   * sender, intent, title, and any attachment paths. */
  input: TurnInputItem[];
  /** Always `"never"` for Bridge. */
  approvalPolicy: "never";
  /** Resolved per-turn from the full-access flag. */
  sandboxPolicy: TurnSandboxPolicy;
}

/** Supported input item types in a `turn/start`. Bridge only sends
 * text; images and file attachments are deferred. */
export type TurnInputItem = { type: "text"; text: string };

/** `turn/interrupt` params. Cancels an in-flight turn on a thread.
 * `turnId` is optional; the app-server accepts a thread-level cancel
 * and resolves it against the currently active turn, which is what
 * Bridge wants since there is always at most one turn per thread. */
export interface TurnInterruptParams {
  threadId: string;
  turnId?: string;
}

// -----------------------------------------------------------------------
// Type guards
// -----------------------------------------------------------------------

/** Helper predicate: is this payload a JSON-RPC response (has `id`
 * and either `result` or `error`)?
 *
 * Note: codex app-server omits the `jsonrpc` version field on both
 * responses and notifications, so we treat `jsonrpc` as optional and
 * only enforce it when present. A strict spec-literal parser would
 * reject those frames entirely, but the server is the ground truth
 * and we have to talk to what it actually sends. */
export function isJsonRpcResponse(
  payload: unknown
): payload is JsonRpcResponse {
  if (typeof payload !== "object" || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  if (obj.jsonrpc !== undefined && obj.jsonrpc !== "2.0") return false;
  if (typeof obj.id !== "number") return false;
  return "result" in obj || "error" in obj;
}

/** Helper predicate: is this payload a JSON-RPC notification (no
 * `id`, has `method` and `params`)? Same jsonrpc-optional caveat
 * as `isJsonRpcResponse`. */
export function isJsonRpcNotification(
  payload: unknown
): payload is JsonRpcNotification {
  if (typeof payload !== "object" || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  if (obj.jsonrpc !== undefined && obj.jsonrpc !== "2.0") return false;
  if ("id" in obj && obj.id !== undefined) return false;
  if (typeof obj.method !== "string") return false;
  return true;
}

/** Helper predicate: does this response carry an error body? */
export function isJsonRpcErrorResponse(
  response: JsonRpcResponse
): response is JsonRpcErrorResponse {
  return "error" in response;
}
