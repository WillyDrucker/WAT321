import { statSync } from "node:fs";
import { tryRolloutRecovery } from "./rolloutRecovery";

/**
 * Per-turn freshness gate for rollout-recovery callbacks. Captures
 * the seed assistant text + rollout file size at turn dispatch and
 * exposes a single `isFreshText(text)` predicate that every recovery
 * site uses to confirm a candidate is genuinely new content for THIS
 * turn (not stale text from a prior turn already in the rollout).
 *
 * Why both axes: text-equality alone false-negatives on a rollout
 * whose new content happens to render the same final answer as the
 * prior turn (rare but observed). Size growth past the seed is
 * unambiguous proof of new bytes for our thread, since each thread
 * owns its rollout file and only the app-server writes to it.
 */

export interface FreshnessGate {
  /** True when `text` is demonstrably new for this turn - either it
   * differs from the seed OR the rollout has grown past the seed
   * size. */
  isFreshText(text: string): boolean;
  /** Seed text captured at construction. Exposed for callers that
   * want to log or assert the baseline. */
  seedAssistantText: string;
  /** Seed rollout size in bytes at construction. Same exposure
   * rationale as `seedAssistantText`. */
  seedRolloutSize: number;
}

/** Build a freshness gate for the rollout at `seedRolloutPath`.
 * Pass a `resolveRolloutPath` so the gate can re-read the file's
 * current size when checking freshness - lazy path resolution lets
 * the gate work even when the rollout file did not exist at gate
 * construction time. */
export function createFreshnessGate(
  seedRolloutPath: string | null,
  resolveRolloutPath: () => string | null
): FreshnessGate {
  const seedAssistantText = seedRolloutPath
    ? (() => {
        try {
          return tryRolloutRecovery(seedRolloutPath) ?? "";
        } catch {
          return "";
        }
      })()
    : "";
  const seedRolloutSize = seedRolloutPath ? sizeOrZero(seedRolloutPath) : 0;

  return {
    isFreshText(text) {
      if (text !== seedAssistantText) return true;
      const path = resolveRolloutPath();
      if (!path) return false;
      return sizeOrZero(path) > seedRolloutSize;
    },
    seedAssistantText,
    seedRolloutSize,
  };
}

function sizeOrZero(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
