import https from "https";

import { REQUEST_TIMEOUT_MS } from "./constants";
import { HttpError } from "./httpError";

export interface HttpGetJsonOptions {
  url: string;
  headers: Record<string, string>;
  /** Override the default REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * AbortController for cancellation. The caller is responsible for
   * constructing and retaining the controller so it can be aborted from
   * outside (e.g. on service dispose).
   */
  abortController: AbortController;
  /**
   * Optional non-200 response parser. Called with the raw body and response
   * headers. If it returns an HttpError, that error is thrown; otherwise a
   * plain Error with the status line is thrown. Use this to pull Retry-After
   * or other response-header data into the error object.
   */
  onNon200?: (
    statusCode: number,
    body: string,
    headers: Record<string, string | string[] | undefined>
  ) => HttpError;
}

/**
 * Perform an HTTPS GET that returns parsed JSON on success and throws a
 * structured error on failure. Uses `agent: false` for every request to
 * avoid stale keep-alive socket reuse after idle periods.
 *
 * Error shapes:
 * - Network failures (ENOTFOUND, ECONNRESET, etc.) reject with the raw Error
 * - Timeouts reject with Error("Request timed out")
 * - Aborts reject with Error("Aborted")
 * - Non-200 responses reject with HttpError (or onNon200 result if provided)
 * - JSON parse failures reject with Error("Invalid JSON in API response")
 */
export function httpGetJson<T>(options: HttpGetJsonOptions): Promise<T> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    const { signal } = options.abortController;

    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error("Request timed out"));
    }, timeoutMs);

    if (signal.aborted) {
      clearTimeout(timeout);
      reject(new Error("Aborted"));
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      request.destroy();
      reject(new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort);

    const request = https.request(
      options.url,
      {
        method: "GET",
        // Fresh TCP connection per request - avoids stale keep-alive
        // sockets after idle that cause spurious ECONNRESET and timeouts.
        agent: false,
        headers: options.headers,
      },
      (response) => {
        let data = "";
        response.on("data", (chunk: string) => (data += chunk));
        response.on("end", () => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", onAbort);

          const statusCode = response.statusCode ?? 0;
          if (statusCode === 200) {
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              reject(new Error("Invalid JSON in API response"));
            }
            return;
          }

          if (options.onNon200) {
            reject(options.onNon200(statusCode, data, response.headers));
          } else {
            reject(new Error(`HTTP ${statusCode}: ${data}`));
          }
        });
      }
    );

    request.on("error", (error) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    request.end();
  });
}
