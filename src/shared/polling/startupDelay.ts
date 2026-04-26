import type { ServiceState } from "../../engine/serviceTypes";
import type { Coordinator } from "../cacheCoordinator";
import { FETCH_COOLDOWN_MS, STARTUP_JITTER_MS } from "./constants";
import { resolveStateFreshness } from "./stateMachine";

/**
 * Compute how long to wait before the first refresh cycle. Shared by
 * both usage services so their startup behavior stays identical.
 *
 * Logic:
 *   - If a fresh cache exists, wait against that state's own freshness
 *     window so short-bucket states (no-auth, token-expired, offline,
 *     error) re-check quickly after the user fixes them.
 *   - Otherwise, wait against the configured poll cooldown.
 *   - Add random jitter so two VS Code windows starting at the same
 *     second do not fire in the same millisecond.
 *   - Enforce a 5-second minimum so startup always has at least one
 *     tick of breathing room.
 */
const MIN_STARTUP_DELAY_MS = 5_000;

export function computeStartupDelay<TData>(
  coordinator: Coordinator<ServiceState<TData>>
): number {
  const cache = coordinator.readCache();
  let base: number;

  if (cache && coordinator.isFresh(cache)) {
    const elapsed = Date.now() - cache.timestamp;
    const stateFreshness = resolveStateFreshness(cache.state);
    base = Math.max(MIN_STARTUP_DELAY_MS, stateFreshness - elapsed);
  } else {
    const lastFetchTime = cache?.timestamp ?? 0;
    const elapsed = Date.now() - lastFetchTime;
    base = Math.max(MIN_STARTUP_DELAY_MS, FETCH_COOLDOWN_MS - elapsed);
  }

  const jitter = Math.floor(Math.random() * STARTUP_JITTER_MS);
  return base + jitter;
}
