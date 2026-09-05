/**
 * `fetch` with an abort deadline. Resolves null on timeout and on any
 * network error alike, so the pollers and probes that read the
 * managed `opencode serve` and llama-server endpoints treat every
 * failure as "no answer this tick".
 */
export async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
