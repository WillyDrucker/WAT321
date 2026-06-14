import {
  CACHE_BANNER_FLASH_MS,
  CACHE_BANNER_FRAME_MS,
  CACHE_LOAD_BANNER_OFF,
  CACHE_LOAD_BANNER_ON,
  CACHE_MISS_BANNER_OFF,
  CACHE_MISS_BANNER_ON,
  CACHE_REBUILD_CREATION_MIN,
  CACHE_REBUILD_RATIO_DENOM,
} from "./sessionTokenHelpers";
import type { SessionTokenRenderData } from "./sessionTokenTypes";

/**
 * Cache-banner state machine for the session-token widget. Owns the
 * per-session watermarks (session id, usage signature, compact ts,
 * awaiting-first-load latch) and the flash-window timestamps. Pure-
 * input / pure-output: `observe(data)` is called once per `ok` render
 * with the latest render data and decides whether a banner should
 * fire. `bannerAt(now)` returns what to display right now (or null).
 *
 * Read-only contract (load-bearing): no HTTP calls, no process
 * spawns, no file writes - only in-memory state mutations driving a
 * 2-second visual pulse. Thresholds in sessionTokenHelpers are tuned
 * against 25k+ sampled signatures - do not loosen without a fresh
 * false-fire audit.
 *
 * Claude path (cc/cr tokens available):
 *   1. Strict ratio (involuntary eviction): `cacheCreation >=
 *      CREATION_MIN` AND `cacheCreation >= cachedInput * RATIO_DENOM`.
 *      Fires red MISS.
 *   2. Compact-driven (deliberate rebuild): `awaitingFirstLoad` armed
 *      AND `cacheCreation >= CREATION_MIN`. Fires yellow LOAD. Armed
 *      only by brand-new attach (no prior usage) or by
 *      `newCompactObserved` mid-session.
 *
 * Codex path (no token-level cache breakdown): marker-only. A new
 * `compacted` / `context_compacted` rollout entry fires LOAD
 * immediately. No MISS detection - Codex doesn't surface evictions.
 */

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
