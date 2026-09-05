/**
 * JSON-RPC 2.0 envelopes and the guards that tell them apart on the
 * wire. Method-specific param and result shapes live in
 * `protocol.ts`. Codex app-server omits the `jsonrpc` version field
 * on both responses and notifications, so the guards treat it as
 * optional and only enforce it when present: a strict spec-literal
 * parser would reject those frames entirely, but the server is the
 * ground truth and we have to talk to what it actually sends.
 */

export const JSONRPC_VERSION = "2.0";

/** A JSON-RPC 2.0 request envelope sent from client to server. */
export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: TParams;
}

/** A JSON-RPC 2.0 successful response. */
interface JsonRpcSuccessResponse<TResult = unknown> {
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

/** Is this payload a JSON-RPC response (has `id` and either `result`
 * or `error`)? */
export function isJsonRpcResponse(
  payload: unknown
): payload is JsonRpcResponse {
  if (typeof payload !== "object" || payload === null) return false;
  const obj = payload as Record<string, unknown>;
  if (obj.jsonrpc !== undefined && obj.jsonrpc !== "2.0") return false;
  if (typeof obj.id !== "number") return false;
  return "result" in obj || "error" in obj;
}

/** Is this payload a JSON-RPC notification (no `id`, has `method`)? */
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

/** Does this response carry an error body? */
export function isJsonRpcErrorResponse(
  response: JsonRpcResponse
): response is JsonRpcErrorResponse {
  return "error" in response;
}
