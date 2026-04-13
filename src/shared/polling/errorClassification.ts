/**
 * Error classifiers shared by both usage services. Both Claude and
 * Codex observe the same `node:http` / network error shapes, so the
 * "is this a transient network blip?" predicate and the Retry-After
 * parser live here instead of being duplicated in each service.
 */

/** Transient network-error strings we absorb silently once, surfacing
 * as "offline" only after ERROR_ABSORPTION_THRESHOLD consecutive hits.
 * These cover stale keep-alive sockets after idle, brief DNS hiccups,
 * and middlebox RST windows. */
const NETWORK_ERROR_PATTERNS = [
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "Request timed out",
];

/** Return true if the error message looks like a transient network
 * failure we should absorb rather than surface as an error state. */
export function isNetworkError(message: string): boolean {
  return NETWORK_ERROR_PATTERNS.some((p) => message.includes(p));
}

/** Parse an HTTP `Retry-After` header value (seconds or HTTP date)
 * into milliseconds. Returns `undefined` if the value is missing or
 * unparseable; callers fall back to the configured backoff. The lower
 * bound of 1 second prevents a zero/negative value from hammering
 * the endpoint in a tight retry loop. */
export function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1_000, Math.round(seconds * 1_000));
  }

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return undefined;
  return Math.max(1_000, retryAt - Date.now());
}
