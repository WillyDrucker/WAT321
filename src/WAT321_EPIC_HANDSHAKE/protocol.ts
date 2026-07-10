import type { CodexEffortOverride } from "../engine/bridgeTypes";

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
 *     - model/list          - models THIS app-server can actually run
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
 * Codex adds a field, our code keeps working - if a field we rely on
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
 * specific - we treat it as unknown and let callers inspect. */
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
 * this client. Always opens the thread at maximum capability
 * ceiling (`approvalPolicy: "never"`, `sandbox: "danger-full-access"`)
 * so any per-turn dial-down is reachable without a thread reset.
 * Per-turn `model`, `effort`, and `sandboxPolicy` overrides are
 * applied on every `turn/start` (see `TurnStartParams`). The Codex
 * Session Settings menu picker writes runtime override flag files
 * that turnRunner reads on every dispatch - the flags persist across
 * activations and clear on Reset WAT321.
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
 *   - `thread/start.sandbox` -> kebab string (`"read-only"`, `"danger-full-access"`)
 *   - `turn/start.sandboxPolicy.type` -> camelCase (`"readOnly"`, `"dangerFullAccess"`)
 * Both casings are native to the app-server's Rust source. Do not
 * try to unify - the server rejects the wrong casing at the wrong
 * layer. */
export type TurnSandboxPolicy =
  | { type: "readOnly" }
  | { type: "workspaceWrite" }
  | { type: "dangerFullAccess" };

/** `turn/start` params. Begins a new turn with the given input.
 *
 * `approvalPolicy` is always `"never"` - the bridge has no UI to
 * relay Codex's approval prompts back mid-turn.
 *
 * `sandboxPolicy`, `model`, and `effort` are read from per-session
 * override flag files (`codex-full-access.flag`, `codex-model.flag`,
 * `codex-effort.flag`) on every turn. Toggling any of them in the
 * Codex Defaults picker takes effect on the next prompt - per-turn
 * pass-through, no thread reset. `model` and `effort` accept null
 * when no override is set - Codex falls back to the thread / config
 * default in that case. Verified empirically that Codex enforces
 * per-turn values (turn_context records them and the tool router
 * blocks out-of-policy operations). */
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
  /** Model override slug. Null = inherit thread / config default. */
  model: string | null;
  /** Reasoning effort override. Null = inherit thread / config default.
   * A level is legal when the target model advertises it, so the wire
   * type does not re-gate what the live catalog already gated. */
  effort: CodexEffortOverride;
}

/** Supported input item types in a `turn/start`. Bridge only sends
 * text - images and file attachments are deferred. */
export type TurnInputItem = { type: "text"; text: string };

/** `turn/interrupt` params. Cancels an in-flight turn on a thread.
 * `turnId` is optional - the app-server accepts a thread-level cancel
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

// -----------------------------------------------------------------
// model/list
// -----------------------------------------------------------------

/**
 * `model/list` reports the models the app-server on the other end of
 * this pipe can actually run. Verified against codex-cli 0.142.5,
 * 0.144.0-alpha.4, and 0.144.1: identical shape on all three, so one
 * binding covers every version we support.
 *
 * WARNING: the field names here are NOT the ones in
 * `~/.codex/models_cache.json`. The RPC is camelCase and renames every
 * field we care about (`slug` -> `id`, `visibility` -> `hidden`,
 * `supported_reasoning_levels[].effort` ->
 * `supportedReasoningEfforts[].reasoningEffort`,
 * `default_reasoning_level` -> `defaultReasoningEffort`). Do not
 * copy-paste shapes between the two.
 *
 * Two further differences that drive design decisions upstream:
 *   - `isDefault` exists here and nowhere in the file, so we no longer
 *     guess the default model by sorting on `priority`.
 *   - `context_window` exists in the file and NOT here, so the
 *     auto-compact ceiling cannot move onto this RPC.
 *
 * The response omits hidden models entirely (0.142.5 returns 3 where
 * its file lists 4), so `hidden` has always been observed false.
 */
export interface ModelListParams {
  /** Omit for the first page. Feed back `nextCursor` for the rest. */
  cursor?: string;
}

export interface ModelListReasoningEffort {
  reasoningEffort: string;
  description?: string;
}

export interface ModelListEntry {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  /** Codex's own answer to "which model when config.toml names none".
   * Tracks the binary: 0.142.5 flags gpt-5.5, 0.144.x flags
   * gpt-5.6-sol. */
  isDefault?: boolean;
  defaultReasoningEffort?: string | null;
  supportedReasoningEfforts?: ModelListReasoningEffort[];
}

/** Cursor-paginated. `nextCursor` is null on the final page. Every
 * version observed returns the full set on page one, but the cursor is
 * part of the contract so we honor it. */
export interface ModelListResult {
  data: ModelListEntry[];
  nextCursor?: string | null;
}
