/**
 * Failure handling for dispatcher turn attempts. Codex surfaces
 * errors as `AppServerRequestError` with a free-form message;
 * numeric codes are not consistent across Codex versions, so we
 * match on message substrings.
 *
 *   rotate   - thread no longer exists on Codex side; spawn fresh S<N+1>
 *   compact  - context window exceeded; compact-and-retry on same thread
 *   retry    - transient (network, overload, rate limit); caller re-tries
 *   surface  - user-fixable (auth, bad request, sandbox); do not rotate
 */

export type FailureClass = "rotate" | "compact" | "retry" | "surface";

export function classifyFailure(err: unknown): FailureClass {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("thread not found") || msg.includes("not found")) {
    return "rotate";
  }
  if (msg.includes("contextwindowexceeded") || msg.includes("context window")) {
    return "compact";
  }
  if (
    msg.includes("overload") ||
    msg.includes("httpconnection") ||
    msg.includes("responsestream") ||
    msg.includes("timeout") ||
    msg.includes("usagelimit") ||
    msg.includes("rate")
  ) {
    return "retry";
  }
  return "surface";
}
