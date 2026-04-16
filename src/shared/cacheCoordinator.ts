import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { releaseClaim, tryAcquireClaim } from "./claimFile";

/**
 * Cross-instance coordinator for shared API state.
 *
 * Multiple VS Code windows running the same extension share a single
 * cache file per provider. Only one instance at a time holds a claim
 * and actually calls the API. Others read the cache and display the
 * shared state.
 *
 * Design:
 *   - Cache file stores `{ timestamp, state }` as JSON
 *   - Claim file is managed by `./claimFile.ts` via atomic O_EXCL create
 *   - Stale claims (> `claimTtlMs`) can be overwritten by any instance
 *   - Per-instance read throttle prevents excessive disk reads
 */
export class Coordinator<TState> {
  private cachedRead: { timestamp: number; state: TState } | null = null;
  private lastReadAt = 0;

  constructor(
    private readonly cachePath: string,
    private readonly claimPath: string,
    private readonly freshnessMs: number,
    private readonly claimTtlMs: number,
    private readonly readThrottleMs: number = 15_000,
    /**
     * Optional resolver that returns a per-state freshness window in ms.
     * Falls back to `freshnessMs` when not provided or when it returns
     * a non-positive value. Used to keep long freshness for `ok` states
     * and shorter freshness for auth/error states.
     */
    private readonly stateFreshnessMs?: (state: TState) => number
  ) {}

  /** Read cache with in-memory throttle to limit disk reads per instance. */
  readCache(): { timestamp: number; state: TState } | null {
    const now = Date.now();
    if (
      now - this.lastReadAt < this.readThrottleMs &&
      this.cachedRead !== null
    ) {
      return this.cachedRead;
    }
    this.lastReadAt = now;

    try {
      const json = readFileSync(this.cachePath, "utf8");
      const parsed = JSON.parse(json);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof parsed.timestamp !== "number"
      ) {
        return null;
      }
      // Guard against future timestamps (clock skew).
      if (parsed.timestamp > now) return null;
      this.cachedRead = parsed;
      return parsed;
    } catch {
      this.cachedRead = null;
      return null;
    }
  }

  /** Force a fresh read bypassing the throttle (use sparingly). */
  readCacheFresh(): { timestamp: number; state: TState } | null {
    this.lastReadAt = 0;
    return this.readCache();
  }

  /**
   * Is this cache entry considered fresh? Uses the per-state resolver
   * if provided, so e.g. error states age out faster than `ok`.
   */
  isFresh(cache: { timestamp: number; state: TState } | null): boolean {
    if (!cache) return false;
    let window = this.freshnessMs;
    if (this.stateFreshnessMs) {
      const resolved = this.stateFreshnessMs(cache.state);
      if (resolved > 0) window = resolved;
    }
    return Date.now() - cache.timestamp < window;
  }

  /** Write the latest state to the cache file. Best-effort. */
  writeCache(state: TState): void {
    try {
      const dir = dirname(this.cachePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify({ timestamp: Date.now(), state });
      writeFileSync(this.cachePath, payload);
      // Invalidate our own throttled read so the next call returns
      // fresh data.
      this.lastReadAt = 0;
    } catch {
      // best-effort
    }
  }

  /** Try to atomically claim the refresh slot. See `./claimFile.ts`. */
  tryClaim(): boolean {
    return tryAcquireClaim(this.claimPath, this.claimTtlMs);
  }

  /** Release our claim on the refresh slot. Best-effort. */
  releaseClaim(): void {
    releaseClaim(this.claimPath);
  }
}
