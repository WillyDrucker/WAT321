import type { ServiceState } from "../types";
import { CACHE_FRESHNESS_ERROR_MS, CACHE_FRESHNESS_OK_MS } from "./constants";

/**
 * States that are worth writing to a shared cache. Transient/init states
 * (loading, not-connected) are per-instance so they are never serialized.
 */
export function isCacheableState<TData>(state: ServiceState<TData>): boolean {
  return (
    state.status === "ok" ||
    state.status === "rate-limited" ||
    state.status === "no-auth" ||
    state.status === "token-expired" ||
    state.status === "offline" ||
    state.status === "error"
  );
}

/**
 * Deep equality on a service state for the fields that affect widget
 * rendering and shared cache writes. Used to dedupe emissions so listeners
 * do not re-render on identical values.
 */
export function statesEqual<TData>(
  a: ServiceState<TData>,
  b: ServiceState<TData>
): boolean {
  if (a.status !== b.status) return false;
  if (a.status === "ok" && b.status === "ok") {
    return JSON.stringify(a.data) === JSON.stringify(b.data);
  }
  if (a.status === "rate-limited" && b.status === "rate-limited") {
    return (
      a.rateLimitedAt === b.rateLimitedAt &&
      a.retryAfterMs === b.retryAfterMs &&
      a.source === b.source
    );
  }
  return true;
}

/**
 * Per-state cache freshness window. OK and rate-limited are slow-changing
 * so they use the long window. Auth and error states might clear the
 * moment the user fixes them, so they use the short window. This lets one
 * window's recovery propagate across instances quickly while still sharing
 * ok/rate-limited broadly.
 */
export function resolveStateFreshness<TData>(
  state: ServiceState<TData>
): number {
  switch (state.status) {
    case "ok":
    case "rate-limited":
      return CACHE_FRESHNESS_OK_MS;
    case "no-auth":
    case "token-expired":
    case "offline":
    case "error":
      return CACHE_FRESHNESS_ERROR_MS;
    default:
      return CACHE_FRESHNESS_OK_MS;
  }
}
