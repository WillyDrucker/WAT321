/**
 * Error classifiers shared by both usage services. Both Claude and
 * Codex observe the same `node:http` / network error shapes, so the
 * "is this a transient network blip?" predicate, the Retry-After
 * parser, and the friendly server-message extractor live here
 * instead of being duplicated in each service.
 */

import { HttpError } from "./httpError";

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

/** Friendly names for the HTTP status codes the usage services
 * might realistically observe from either provider's edge. Covers
 * the standard RFC 9110 shapes plus Cloudflare's 52x/530 family
 * because both providers front through Cloudflare and a CDN error
 * page surfaces those codes verbatim. */
const HTTP_STATUS_NAMES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  413: "Payload Too Large",
  422: "Unprocessable Entity",
  425: "Too Early",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  520: "Web Server Unknown Error",
  521: "Web Server Is Down",
  522: "Connection Timed Out",
  523: "Origin Is Unreachable",
  524: "A Timeout Occurred",
  530: "Origin DNS Error",
};

/** Plain-English hint appended after the status name, explaining in
 * one short phrase what the error usually means from the user's
 * perspective. 429 and the 5xx family all collapse to "possible API
 * outage" because an absurd `Retry-After` from a flailing edge
 * reads exactly like a 5xx from the user's point of view - the tool
 * is offline and they cannot do anything about it. The 4xx
 * request-problem codes rarely fire in practice (our requests are
 * well-formed) but hint them anyway in case a future API change
 * starts returning them. Cloudflare's 52x family gets its own CDN
 * phrasing so the user can tell the issue is upstream of Anthropic
 * or OpenAI proper. */
const HTTP_STATUS_HINTS: Readonly<Record<number, string>> = {
  400: "malformed request",
  408: "request timed out",
  413: "request too large",
  422: "invalid request body",
  429: "possible API outage",
  500: "possible API outage",
  502: "possible API outage",
  503: "possible API outage",
  504: "possible API outage",
  520: "CDN connectivity issue",
  521: "CDN origin offline",
  522: "CDN origin timeout",
  523: "CDN origin unreachable",
  524: "CDN origin timeout",
  530: "CDN DNS issue",
};

/** Extract a user-friendly one-line summary of an HttpError suitable
 * for display in a status bar tooltip. Prefers a JSON-parsed message
 * field when present (tries `error.message` for the Anthropic and
 * OpenAI shapes, then bare `message`, then `detail` for the
 * FastAPI / OpenAPI style). Falls back to a canonical
 * `HTTP {code} {name} ({hint})` string when the body is not JSON or
 * lacks a recognizable message field. Raw response bodies are NEVER
 * returned as-is because a Cloudflare edge error page is HTML and
 * would leak markup into the tooltip. Returns `undefined` for
 * non-HttpError inputs. */
export function extractServerMessage(error: unknown): string | undefined {
  if (!(error instanceof HttpError)) return undefined;
  const code = error.statusCode;

  try {
    const parsed = JSON.parse(error.body) as Record<string, unknown>;
    const nested = parsed.error as Record<string, unknown> | undefined;
    if (nested && typeof nested.message === "string") {
      return `HTTP ${code}: ${nested.message}`;
    }
    if (typeof parsed.message === "string") {
      return `HTTP ${code}: ${parsed.message}`;
    }
    if (typeof parsed.detail === "string") {
      return `HTTP ${code}: ${parsed.detail}`;
    }
  } catch {
    // Body was not JSON - drop it and fall through to the canonical
    // name/hint path. Avoids leaking HTML or whatever the edge
    // returned into the tooltip.
  }

  const name = HTTP_STATUS_NAMES[code];
  const hint = HTTP_STATUS_HINTS[code];
  const base = name ? `HTTP ${code} ${name}` : `HTTP ${code}`;
  return hint ? `${base} (${hint})` : base;
}
