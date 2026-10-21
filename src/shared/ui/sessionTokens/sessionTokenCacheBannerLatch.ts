import type { SessionTokenRenderData } from "./sessionTokenTypes";

/**
 * Cache-banner state machine for the session-token widget. Owns the
 * per-session watermarks (session id, usage signature, compact ts,
 * awaiting-first-load latch) and the flash-window timestamps.
 * `observe(data)` runs once per `ok` render and decides whether a
 * banner fires, `bannerAt(now)` returns what to display right now.
 *
 * Read-only contract: no HTTP, no process spawns, no file writes, only
 * in-memory state driving a 2-second pulse. Claude fires red MISS on
 * the strict creation ratio (involuntary eviction) and yellow LOAD on
 * a compact-driven rebuild while `awaitingFirstLoad` is armed (by a
 * brand-new attach or `newCompactObserved` mid-session). Codex has no
 * token-level cache breakdown, so a `compacted` / `context_compacted`
 * rollout entry fires LOAD and nothing detects MISS.
 */

/** Cache-rebuild floors, tuned against 25k+ sampled signatures (do not
 * loosen without a fresh false-fire audit). Strict ratio: creation >=
 * MIN and creation >= cachedInput * RATIO_DENOM, so creation dominates
 * reads 2:1 and a user-pasted blob does not false-fire. Compact-driven:
 * awaitingFirstLoad and creation >= MIN, because a compact caches a
 * fresh summary beside the surviving prompt and tools, so reads stay
 * non-trivial and the ratio gate would miss it. Real rebuilds land at
 * 5k or more. Exported so `cacheEventParser` classifies with the same
 * floors and the two surfaces never disagree. */
export const CACHE_REBUILD_CREATION_MIN = 5_000;
export const CACHE_REBUILD_RATIO_DENOM = 2;

/** Flash window. 2000ms total - the LOAD/MISS text persists the
 * entire window while the bullets blink at 500ms cadence between a
 * colored emoji (red MISS / yellow LOAD) and a black-circle off
 * frame. Same emoji family for both frames keeps the cell width
 * steady - mixing emoji with ASCII or codicons crosses font tables
 * and shifts the text on every transition. */
const CACHE_BANNER_FLASH_MS = 2000;
const CACHE_BANNER_FRAME_MS = 500;
const CACHE_LOAD_BANNER_ON = "🟡LOAD🟡";
const CACHE_LOAD_BANNER_OFF = "⚫LOAD⚫";
const CACHE_MISS_BANNER_ON = "🔴MISS🔴";
const CACHE_MISS_BANNER_OFF = "⚫MISS⚫";

export interface CacheBannerLatch {
  /** Apply the latest render data to the latch. Returns whether the
   * session id changed since the previous observe call (the widget
   * uses this to reset its TPS throttle). */
  observe(data: SessionTokenRenderData): { sessionChanged: boolean };
  /** Banner text to render right now, or null if no flash is active. */
  bannerAt(now: number): string | null;
  /** Convenience predicate for the animation-active gate. */
  isFlashing(now: number): boolean;
}

export function createCacheBannerLatch(): CacheBannerLatch {
  /** Last usage bundle signature seen: `output:totalInput:cached:creation`.
   * Guards against double-firing on the same turn across overlapping
   * polls. Reset on session change. */
  let lastUsageSignature: string | null = null;
  let cacheLoadFlashStartedAt: number | null = null;
  let cacheMissFlashStartedAt: number | null = null;
  /** Session this latch last observed. Switch resets per-session state
   * so the new session's first qualifying turn reads as LOAD, not MISS. */
  let lastSeenSessionId: string | null = null;
  /** Most recent compact summary timestamp reacted to. Newer than this
   * arms `awaitingFirstLoad` so the trailing rebuild fires LOAD.
   * Adopted (not fired) on session change so historical compacts in the
   * tail never produce spurious LOADs. */
  let lastSeenCompactTimestamp: number | null = null;
  /** True only when a deliberate rebuild is expected on the next
   * qualifying turn. Armed by brand-new attach (no prior usage) or
   * mid-session `newCompactObserved`. Subsequent rebuilds in the same
   * epoch fire red MISS via the strict ratio gate. */
  let awaitingFirstLoad = false;

  function observe(
    data: SessionTokenRenderData
  ): { sessionChanged: boolean } {
    let sessionChanged = false;

    if (data.sessionId !== lastSeenSessionId) {
      sessionChanged = true;
      lastSeenSessionId = data.sessionId;
      lastSeenCompactTimestamp = data.lastCompactTimestamp;

      const info = data.claudeTurnInfo;
      const hasExistingUsage =
        info !== undefined &&
        (info.totalInputTokens > 0 ||
          info.cacheCreationTokens > 0 ||
          info.cachedInputTokens > 0);

      if (info !== undefined && hasExistingUsage) {
        lastUsageSignature = `${info.outputTokens}:${info.totalInputTokens}:${info.cachedInputTokens}:${info.cacheCreationTokens}`;
        awaitingFirstLoad = false;
      } else {
        lastUsageSignature = null;
        // Brand-new Claude session arms the latch so its first turn
        // fires LOAD as the genuine first cache build. Codex (info
        // undefined) leaves the latch off - the Codex path uses
        // newCompactObserved exclusively as its LOAD trigger.
        awaitingFirstLoad = info !== undefined;
      }
    }

    // Allow a null watermark so a session attached with no compacts
    // can still detect its first-ever compact.
    const compactTs = data.lastCompactTimestamp;
    const newCompactObserved =
      compactTs !== null &&
      (lastSeenCompactTimestamp === null ||
        compactTs > lastSeenCompactTimestamp);

    if (newCompactObserved) {
      lastSeenCompactTimestamp = compactTs;
      awaitingFirstLoad = true;
    }

    const info = data.claudeTurnInfo;
    if (info === undefined) {
      // Codex path: marker-only. No cache_creation tokens to gate on.
      if (newCompactObserved) {
        cacheLoadFlashStartedAt = Date.now();
        awaitingFirstLoad = false;
      }
      return { sessionChanged };
    }

    // Claude path: token-gated detection.
    const sig = `${info.outputTokens}:${info.totalInputTokens}:${info.cachedInputTokens}:${info.cacheCreationTokens}`;
    if (sig === lastUsageSignature) return { sessionChanged };
    lastUsageSignature = sig;

    const cc = info.cacheCreationTokens;
    const cr = info.cachedInputTokens;
    if (cc < CACHE_REBUILD_CREATION_MIN) return { sessionChanged };
    const meetsStrict = cc >= cr * CACHE_REBUILD_RATIO_DENOM;
    if (!meetsStrict && !awaitingFirstLoad) return { sessionChanged };

    const now = Date.now();
    if (awaitingFirstLoad) {
      cacheLoadFlashStartedAt = now;
      awaitingFirstLoad = false;
    } else {
      cacheMissFlashStartedAt = now;
    }
    return { sessionChanged };
  }

  /** Four 500ms frames across 2000ms, alternating colored emoji and
   * black-circle off frame. Text persists the whole window - only the
   * bullets blink. */
  function bannerAt(now: number): string | null {
    if (cacheLoadFlashStartedAt !== null) {
      const elapsed = now - cacheLoadFlashStartedAt;
      if (elapsed < CACHE_BANNER_FLASH_MS) {
        const onFrame = Math.floor(elapsed / CACHE_BANNER_FRAME_MS) % 2 === 0;
        return onFrame ? CACHE_LOAD_BANNER_ON : CACHE_LOAD_BANNER_OFF;
      }
    }
    if (cacheMissFlashStartedAt !== null) {
      const elapsed = now - cacheMissFlashStartedAt;
      if (elapsed < CACHE_BANNER_FLASH_MS) {
        const onFrame = Math.floor(elapsed / CACHE_BANNER_FRAME_MS) % 2 === 0;
        return onFrame ? CACHE_MISS_BANNER_ON : CACHE_MISS_BANNER_OFF;
      }
    }
    return null;
  }

  function isFlashing(now: number): boolean {
    if (cacheLoadFlashStartedAt !== null &&
        now - cacheLoadFlashStartedAt < CACHE_BANNER_FLASH_MS) {
      return true;
    }
    if (cacheMissFlashStartedAt !== null &&
        now - cacheMissFlashStartedAt < CACHE_BANNER_FLASH_MS) {
      return true;
    }
    return false;
  }

  return { observe, bannerAt, isFlashing };
}
