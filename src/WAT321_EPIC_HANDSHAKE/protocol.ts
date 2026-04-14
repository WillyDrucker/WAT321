/**
 * Typed bindings for the `codex app-server` JSON-RPC 2.0 protocol.
 *
 * Reference: https://developers.openai.com/codex/app-server and the
 * Rust source in `openai/codex/codex-rs/app-server-protocol/`. We
 * only bind the methods and notifications Epic Handshake actually
 * uses in v1.1.0:
 *
 *   Requests:
 *     - initialize          - handshake at connection start
 *     - thread/start        - create a fresh Bridge thread
 *     - thread/resume       - resume a persisted thread by id
 *     - thread/read         - read persisted state without resuming
 *     - turn/start          - dispatch a Bridge message as a turn
 *     - turn/interrupt      - cancel an in-flight turn
 *
 *   Notifications (server to client):
 *     - turn/started
 *     - item/started
 *     - item/agentMessage/delta
 *     - item/completed
 *     - turn/diff/updated    (ignored when sandboxPolicy is readOnly)
 *     - thread/tokenUsage/updated   (log-only)
 *     - turn/completed       (terminal for a turn)
 *     - thread/closed        (recovery trigger)
 *
 * Design note on type strictness: request params are typed strictly
 * so TypeScript enforces correctness on what we SEND. Results are
 * typed as `unknown` - callers do their own runtime shape check on
 * the fields they read. This insulates us from minor server-side
 * schema changes: if Codex adds a field, our code keeps working;
 * if a field we rely on goes missing, the runtime check fails loud
 * at exactly the call site that cares.
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
// Well-known error codes
// -----------------------------------------------------------------------

/** Backpressure: server overloaded, client should retry with
 * exponentially increasing delay plus jitter. Documented in the
 * Codex app-server README. */
export const ERROR_CODE_OVERLOADED = -32001;

/** Standard JSON-RPC error codes we may encounter. */
export const ERROR_CODE_PARSE_ERROR = -32700;
export const ERROR_CODE_INVALID_REQUEST = -32600;
export const ERROR_CODE_METHOD_NOT_FOUND = -32601;
export const ERROR_CODE_INVALID_PARAMS = -32602;
export const ERROR_CODE_INTERNAL_ERROR = -32603;

// -----------------------------------------------------------------------
// Request / result types for the methods Epic Handshake uses
// -----------------------------------------------------------------------

/** Method name constants. String-valued so the compiler can still
 * narrow on them when used with a discriminated union. */
export const METHOD_INITIALIZE = "initialize";
export const METHOD_THREAD_START = "thread/start";
export const METHOD_THREAD_RESUME = "thread/resume";
export const METHOD_THREAD_READ = "thread/read";
export const METHOD_TURN_START = "turn/start";
export const METHOD_TURN_INTERRUPT = "turn/interrupt";

export type EpicHandshakeMethod =
  | typeof METHOD_INITIALIZE
  | typeof METHOD_THREAD_START
  | typeof METHOD_THREAD_RESUME
  | typeof METHOD_THREAD_READ
  | typeof METHOD_TURN_START
  | typeof METHOD_TURN_INTERRUPT;

/** `initialize` params. `clientInfo.name` is written to OpenAI's
 * compliance logs so third-party integrations can be identified
 * distinctly from the first-party VS Code extension. We use
 * `wat321_bridge` as a stable identifier. */
export interface InitializeParams {
  clientInfo: {
    name: string;
    version?: string;
  };
  capabilities?: {
    experimentalApi?: boolean;
  };
}

/** `thread/start` params. Creates a fresh Bridge thread owned by
 * this client. */
export interface ThreadStartParams {
  clientInfo?: {
    name: string;
  };
  /** Working directory hint. Bridge does not rely on this for
   * correctness, but app-server may use it for workspace-aware
   * context. We default to the extension's cwd. */
  cwd?: string;
  /** Optional model override. Omit to use the user's default. */
  model?: string;
}

/** `thread/resume` params. Resume a persisted thread by id. */
export interface ThreadResumeParams {
  threadId: string;
}

/** `thread/read` params. Inspects persisted state without loading
 * the thread into memory. Used by the recovery ladder to
 * disambiguate `notLoaded` from `ThreadNotFound`. */
export interface ThreadReadParams {
  threadId: string;
}

/** `turn/start` params. Begins a new turn with the given input.
 * Epic Handshake always pins `sandboxPolicy` to readOnly and
 * `approvalPolicy` to never so Bridge Codex cannot execute tools
 * or modify files. */
export interface TurnStartParams {
  threadId: string;
  /** Input content. We send a single text block constructed from
   * the Bridge message body plus a compact header listing the
   * sender, intent, title, and any attachment paths. */
  input: TurnInputItem[];
  /** Always `"never"` for Bridge. */
  approvalPolicy: "never";
  /** Always `"readOnly"` for Bridge in v1.1.0. */
  sandboxPolicy: "readOnly";
}

/** Supported input item types in a `turn/start`. Bridge only sends
 * text; images and file attachments are deferred. */
export type TurnInputItem = { type: "text"; text: string };

/** `turn/interrupt` params. Cancels an in-flight turn on a thread. */
export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

// -----------------------------------------------------------------------
// Notification names
// -----------------------------------------------------------------------

/** Server to client notification method names. Used by the client's
 * subscription machinery. Payloads are handled as `unknown` and
 * validated at the consumer. */
export const NOTIFICATION_TURN_STARTED = "turn/started";
export const NOTIFICATION_ITEM_STARTED = "item/started";
export const NOTIFICATION_ITEM_AGENT_MESSAGE_DELTA = "item/agentMessage/delta";
export const NOTIFICATION_ITEM_COMPLETED = "item/completed";
export const NOTIFICATION_TURN_DIFF_UPDATED = "turn/diff/updated";
export const NOTIFICATION_THREAD_TOKEN_USAGE_UPDATED =
  "thread/tokenUsage/updated";
export const NOTIFICATION_TURN_COMPLETED = "turn/completed";
export const NOTIFICATION_THREAD_CLOSED = "thread/closed";

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
