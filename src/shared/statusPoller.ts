import { httpGetJson } from "./polling/httpClient";

/**
 * Lazy poller for public Statuspage.io JSON feeds (Anthropic +
 * OpenAI). Appends a status line to the rate-limited tooltip so
 * the user can tell if the cause is upstream.
 *
 * - Lazy refresh from the tooltip render path, TTL-gated to at
 *   most one fetch per `CACHE_TTL_MS` per provider per window.
 * - Silent on failure: returns cached data or null.
 * - In-memory only, no disk cache or cross-window coordination.
 * - Read-only, unauthenticated, zero user data leaves the machine.
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

/** Public Statuspage.io JSON feed URLs per provider. */
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
