import { httpGetJson } from "./polling/httpClient";

/**
 * Lazy poller for the public Statuspage.io JSON feeds that Anthropic
 * and OpenAI publish. Consumed by `usageNonOkRenderer.ts` to append
 * a one-line status summary to the `rate-limited` tooltip when the
 * provider is reporting a live incident, so a user looking at a
 * parked widget can immediately tell the cause is upstream and not
 * WAT321.
 *
 * Design notes:
 *
 * - **Lazy refresh, not a timer.** There is no `setInterval` here.
 *   `refreshIfStale()` is called from the tooltip render path; the
 *   cache TTL gates it so the actual network call fires at most
 *   once per `CACHE_TTL_MS` per provider per VS Code window. The
 *   countdown ticker's 1-second rate-limited re-paint picks up a
 *   freshly fetched entry on the next tick without any explicit
 *   rebroadcast plumbing.
 *
 * - **Silent on failure.** Every error path collapses to "leave the
 *   cache as-is and return whatever we have (possibly null)." A
 *   status endpoint that is itself down during an outage must not
 *   surface a second error about the error.
 *
 * - **In-memory only.** No disk cache, no cross-window coordination.
 *   The payload is ~200 bytes, the cadence is one fetch per 5
 *   minutes per window, and cross-window duplication is cheap.
 *   Skipping the Coordinator pattern keeps this module small.
 *
 * - **First net-new outbound endpoint.** Every prior WAT321 network
 *   call hit the provider's own usage API. This one hits the
 *   provider's own public status page, which is still an
 *   Anthropic/OpenAI-owned property, still read-only, still unauth'd,
 *   and still has zero user data leaving the machine. Documented
 *   here so future readers know the boundary moved.
 */

export type Provider = "claude" | "codex";

export type StatusIndicator =
  | "none"
  | "minor"
  | "major"
  | "critical"
  | "maintenance";

export interface StatusSummary {
  indicator: StatusIndicator;
  description: string;
}

interface CachedStatus {
  summary: StatusSummary;
  fetchedAt: number;
}

/** Anthropic moved their status page from `status.anthropic.com` to
 * `status.claude.com` in early 2026. The old host 302s to the new
 * one; we point directly at the new one to skip the redirect. */
const STATUS_URLS: Readonly<Record<Provider, string>> = {
  claude: "https://status.claude.com/api/v2/status.json",
  codex: "https://status.openai.com/api/v2/status.json",
};

/** Human-readable provider-owner name for tooltip rendering. Codex
 * is OpenAI's product, so the tooltip reads "OpenAI status: ..." not
 * "Codex status: ..." to match what the status page itself says. */
const PROVIDER_OWNER: Readonly<Record<Provider, string>> = {
  claude: "Anthropic",
  codex: "OpenAI",
};

/** How long a successful fetch is considered fresh. Incidents on
 * Statuspage.io rarely transition faster than a few minutes so a
 * 5-minute window is comfortably tight without hammering. */
const CACHE_TTL_MS = 300_000;

/** Short timeout for the status fetch. The payload is tiny and the
 * endpoint is fronted by a CDN, so anything slower than this is a
 * symptom we want to bail on rather than wait out. */
const STATUS_FETCH_TIMEOUT_MS = 5_000;

const cache = new Map<Provider, CachedStatus>();
const inFlight = new Set<Provider>();

/** Synchronous accessor for the most recently fetched status.
 * Returns `null` when no fetch has succeeded yet. Callers should
 * treat `indicator === "none"` as "do not render the status line"
 * because the status page describes that state as "All Systems
 * Operational" and surfacing that every time the widget parks would
 * be noise. */
export function getCachedStatus(provider: Provider): StatusSummary | null {
  return cache.get(provider)?.summary ?? null;
}

/** Fire-and-forget refresh. No-ops when a recent fetch is still
 * fresh, or when a fetch for the same provider is already in
 * flight. Never throws; every error path is swallowed so callers
 * can invoke this from render paths without try/catch scaffolding. */
export function refreshIfStale(provider: Provider): void {
  const cached = cache.get(provider);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return;
  if (inFlight.has(provider)) return;
  inFlight.add(provider);

  const abortController = new AbortController();
  httpGetJson<{ status?: { indicator?: string; description?: string } }>({
    url: STATUS_URLS[provider],
    headers: {},
    abortController,
    timeoutMs: STATUS_FETCH_TIMEOUT_MS,
  })
    .then((data) => {
      const indicator = data?.status?.indicator;
      const description = data?.status?.description;
      if (!isStatusIndicator(indicator) || typeof description !== "string") {
        return;
      }
      cache.set(provider, {
        summary: { indicator, description },
        fetchedAt: Date.now(),
      });
    })
    .catch(() => {
      // Silent - tooltip falls back to omitting the status line.
    })
    .finally(() => {
      inFlight.delete(provider);
    });
}

/** Friendly owner label for display ("Anthropic" / "OpenAI"). */
export function getProviderOwner(provider: Provider): string {
  return PROVIDER_OWNER[provider];
}

function isStatusIndicator(v: unknown): v is StatusIndicator {
  return (
    v === "none" ||
    v === "minor" ||
    v === "major" ||
    v === "critical" ||
    v === "maintenance"
  );
}
