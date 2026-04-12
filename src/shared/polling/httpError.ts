/**
 * HTTP error with structured status code and body for callers that need
 * to differentiate auth failures, rate limits, and server errors from
 * plain network errors. Optional retryAfterMs carries the parsed
 * Retry-After header value when present.
 */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: string,
    public readonly retryAfterMs?: number
  ) {
    super(`HTTP ${statusCode}: ${body}`);
    this.name = "HttpError";
  }
}
