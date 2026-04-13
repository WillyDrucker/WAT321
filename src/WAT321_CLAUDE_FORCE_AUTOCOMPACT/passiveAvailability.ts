import { statSync } from "node:fs";
import {
  readAutoCompactOverride,
  type OverrideReadResult,
} from "../shared/claudeSettings";
import {
  scanTailForCompactHistory,
  type TailHistoryOutcome,
} from "./compactDetector";
import { healStuckOverride } from "./heal";
import {
  determineUnavailableReason,
  determineUnavailableReasonForArm,
  type ActiveContextInfo,
} from "./preflightGate";
import type { UnavailableReason } from "./types";

/**
 * Passive availability tracker. Owns the "is the tool currently
 * available to arm" check without a live click, used by the
 * service's idle poll loop and by the widget's snap checks
 * (session token piggyback + click-time).
 *
 * Two things live here:
 *
 *   1. A cached `ActiveContextInfo` populated by the widget from
 *      every Claude session token service update. The context
 *      fraction is the primary arm gate - the tool is only
 *      meaningful when the user is above 20% of their auto-compact
 *      ceiling. Refreshes via `setActiveContext`, no disk IO.
 *
 *   2. A `maybeAutoRepair` helper that runs `healStuckOverride()`
 *      when the current reason is `settings-stuck-at-armed` AND we
 *      are outside the retry cooldown. Prevents loops against
 *      external writers that keep stomping "1" back in.
 *
 * The loop-detection tail scan is a SECONDARY backup for the
 * context gate (it only matters in the small-ceiling edge case
 * where post-compact context can land above 20% of ceiling). It
 * runs cheaply on a size-delta basis and is cached between ticks.
 *
 * The tracker is decoupled from `PostDisarmWatcher`: no cooldown
 * state is threaded through anymore because the context gate has
 * already subsumed the post-disarm cooldown use case. The watcher
 * still runs in the service but as a CLI-cache diagnostic, not
 * as an arm gate.
 */

/** Backoff between automatic heal attempts for
 * `settings-stuck-at-armed`. First detection auto-heals
 * immediately; if something overwrites our safe value inside this
 * window, we do NOT auto-heal again. Click-to-repair bypasses
 * this cooldown. */
export const HEAL_RETRY_COOLDOWN_MS = 5 * 60_000;

export class PassiveAvailabilityTracker {
  private activeContext: ActiveContextInfo | null = null;
  /** Cached loop-detection tail scan. Refreshed on size changes
   * so the idle 2 s tick stays cheap. Null means "not scanned
   * yet" or "no session". */
  private loopHistory: TailHistoryOutcome | null = null;
  private lastScannedSize = -1;
  /** Wall-clock time of the most recent auto-heal attempt for
   * `settings-stuck-at-armed`. Enforces `HEAL_RETRY_COOLDOWN_MS`
   * between passive heal attempts. Reset to 0 on clean
   * transitions back to `ready`. */
  private lastHealAttemptAt = 0;

  /** Widget hook. Called from `updateClaudeSession` on every
   * Claude session token service update. The context fraction is
   * the primary arm gate. Passing `null` signals "no live
   * session" - the tracker skips the context gate and leaves
   * resolution to the state-based reasons only. */
  setActiveContext(ctx: ActiveContextInfo | null): void {
    if (sameContext(this.activeContext, ctx)) return;
    const prevPath = this.activeContext?.transcriptPath ?? null;
    this.activeContext = ctx;
    // Invalidate the loop-detection cache if the transcript path
    // changed. Same-transcript updates keep the cache warm.
    if (prevPath !== (ctx?.transcriptPath ?? null)) {
      this.loopHistory = null;
      this.lastScannedSize = -1;
    }
  }

  getActiveContext(): ActiveContextInfo | null {
    return this.activeContext;
  }

  /** Reset the heal retry cooldown. Called by the service on
   * clean transitions back into `ready`. */
  resetHealCooldown(): void {
    this.lastHealAttemptAt = 0;
  }

  /**
   * Passive resolver. Used by both the service's idle poll and by
   * snap-check paths. Uses the cached `ActiveContextInfo` plus a
   * cheap size-delta loop scan. Does NOT re-scan unconditionally -
   * the primary context gate is served entirely from cached data.
   */
  resolve(): UnavailableReason | null {
    this.refreshLoopHistoryIfNeeded();
    const read = readAutoCompactOverride();
    let reason = determineUnavailableReason({
      overrideReadResult: read,
      sentinelOwnedByUs: false,
      context: this.activeContext,
      loopHistory: this.loopHistory,
    });
    reason = this.maybeAutoRepair(reason, false);
    return reason;
  }

  /**
   * Forced repair. Bypasses the auto-heal cooldown (explicit user
   * action). The context gate does not block a forced repair - if
   * the user is clicking to fix a stuck state, we try to fix it
   * regardless of their current context.
   */
  resolveForcedRepair(
    currentReason: UnavailableReason
  ): UnavailableReason | null {
    const attempted = this.maybeAutoRepair(currentReason, true);
    // Re-run the resolver against fresh state in case the manual
    // repair fixed the underlying condition.
    const read = readAutoCompactOverride();
    this.refreshLoopHistoryIfNeeded();
    const reason = determineUnavailableReason({
      overrideReadResult: read,
      sentinelOwnedByUs: false,
      context: this.activeContext,
      loopHistory: this.loopHistory,
    });
    return reason !== null ? reason : attempted;
  }

  /**
   * Fresh snap path for `arm()`. Performs a fresh tail scan
   * (never cached) because this is the final defense-in-depth
   * check right before touching disk. Returns the arm-time
   * resolver answer.
   */
  resolveForArm(): UnavailableReason | null {
    const read = readAutoCompactOverride();
    return determineUnavailableReasonForArm(read, false, this.activeContext);
  }

  /** Refresh the loop-history cache ONLY when the transcript file
   * has grown since the last scan. Idle sessions pay only a
   * `statSync`. Active sessions pay the 256 KB tail read once per
   * user turn (roughly once per minute). */
  private refreshLoopHistoryIfNeeded(): void {
    const path = this.activeContext?.transcriptPath ?? null;
    if (!path) {
      this.loopHistory = null;
      this.lastScannedSize = -1;
      return;
    }
    let size: number | null = null;
    try {
      size = statSync(path).size;
    } catch {
      size = null;
    }
    if (size === null || size === this.lastScannedSize) return;
    this.loopHistory = scanTailForCompactHistory(path);
    this.lastScannedSize = size;
  }

  /**
   * Auto-heal a stuck "1" state if the reason calls for it AND we
   * are outside the retry cooldown (or `force` is true). Returns
   * the updated reason so the caller can transition state.
   *
   * Policy:
   *   - `settings-stuck-at-armed` + outside retry cooldown: run
   *     heal, re-resolve, return post-heal reason.
   *   - `settings-stuck-at-armed` + inside retry cooldown: return
   *     unchanged so the widget shows the stuck state with a
   *     click-to-retry tooltip.
   *   - `settings-io-error` + force: run heal in case a fresh
   *     read now succeeds. Never retried passively.
   *   - Any other reason: returned unchanged.
   */
  private maybeAutoRepair(
    reason: UnavailableReason | null,
    force: boolean
  ): UnavailableReason | null {
    if (reason === null) return null;
    if (
      reason !== "settings-stuck-at-armed" &&
      reason !== "settings-io-error"
    ) {
      return reason;
    }
    if (reason === "settings-io-error" && !force) return reason;
    if (!force) {
      const now = Date.now();
      if (
        this.lastHealAttemptAt > 0 &&
        now - this.lastHealAttemptAt < HEAL_RETRY_COOLDOWN_MS
      ) {
        return reason;
      }
    }

    this.lastHealAttemptAt = Date.now();
    const healResult = healStuckOverride();
    if (healResult === "io-error") return "settings-io-error";

    // Heal wrote a safe value (or was a no-op on already-clean
    // state). Re-resolve with fresh state.
    const freshRead: OverrideReadResult = readAutoCompactOverride();
    return determineUnavailableReason({
      overrideReadResult: freshRead,
      sentinelOwnedByUs: false,
      context: this.activeContext,
      loopHistory: this.loopHistory,
    });
  }
}

/** Identity-compare two `ActiveContextInfo` values, treating
 * equal scalar fields as equal objects. Prevents cache
 * invalidation churn when the session token service emits
 * identical-looking updates. */
function sameContext(
  a: ActiveContextInfo | null,
  b: ActiveContextInfo | null
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return (
    a.transcriptPath === b.transcriptPath &&
    a.contextUsed === b.contextUsed &&
    a.ceiling === b.ceiling &&
    a.fraction === b.fraction
  );
}
