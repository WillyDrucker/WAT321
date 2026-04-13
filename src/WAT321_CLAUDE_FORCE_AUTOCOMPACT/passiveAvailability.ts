import { statSync } from "node:fs";
import {
  readAutoCompactOverride,
  SETTINGS_PATH,
  type OverrideReadResult,
} from "../shared/claudeSettings";
import {
  scanTailForCompactHistory,
  type TailHistoryOutcome,
} from "./compactDetector";
import { HEAL_RETRY_COOLDOWN_MS } from "./constants";
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

export class PassiveAvailabilityTracker {
  private activeContext: ActiveContextInfo | null = null;
  /** Cached loop-detection tail scan. Refreshed when the transcript
   * size or mtime changes so the idle 2 s tick stays cheap. Null
   * means "not scanned yet" or "no session". Both size AND mtime
   * are tracked because a rotated transcript could land on an
   * identical byte count while having different contents; the
   * mtime gate catches that case. */
  private loopHistory: TailHistoryOutcome | null = null;
  private lastScannedSize = -1;
  private lastScannedMtimeMs = -1;
  /** Wall-clock time of the most recent auto-heal attempt for
   * `settings-stuck-at-armed`. Enforces `HEAL_RETRY_COOLDOWN_MS`
   * between passive heal attempts. Reset to 0 on clean
   * transitions back to `ready`. */
  private lastHealAttemptAt = 0;

  /**
   * Injected getter that answers "does this tracker's owning
   * service currently hold the sentinel?" Returns `true` only
   * while the service is in the `armed` state with a live in-flight
   * arm. The resolver uses this to distinguish "someone else wrote
   * the sentinel externally" from "we wrote it ourselves and are
   * mid-arm." Defaulting to `() => false` keeps the pre-D1 behavior
   * for call sites that do not care about the distinction.
   */
  constructor(private ownsSentinel: () => boolean = () => false) {}

  /** Cached `~/.claude/settings.json` read. Invalidated when the
   * file's mtime changes. Prevents every idle 15 s tick from doing
   * a fresh disk read + JSON.parse on a file WAT321 does not own
   * and which changes rarely. Cold reads are ~1-2 KB so this is
   * cheap even without the cache, but the mtime gate eliminates
   * the work entirely on most ticks. */
  private settingsCache: {
    mtimeMs: number;
    result: OverrideReadResult;
  } | null = null;

  private cachedReadOverride(): OverrideReadResult {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(SETTINGS_PATH).mtimeMs;
    } catch {
      // File missing or unreadable. Fall through to a direct read
      // so the discriminated-union reader can classify the exact
      // error (missing vs io-error). Invalidate any stale cache.
      this.settingsCache = null;
      return readAutoCompactOverride();
    }
    if (this.settingsCache && this.settingsCache.mtimeMs === mtimeMs) {
      return this.settingsCache.result;
    }
    const result = readAutoCompactOverride();
    this.settingsCache = { mtimeMs, result };
    return result;
  }

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
      this.lastScannedMtimeMs = -1;
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
    const read = this.cachedReadOverride();
    let reason = determineUnavailableReason({
      overrideReadResult: read,
      sentinelOwnedByUs: this.ownsSentinel(),
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
    const read = this.cachedReadOverride();
    this.refreshLoopHistoryIfNeeded();
    const reason = determineUnavailableReason({
      overrideReadResult: read,
      sentinelOwnedByUs: this.ownsSentinel(),
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
    const read = this.cachedReadOverride();
    return determineUnavailableReasonForArm(
      read,
      this.ownsSentinel(),
      this.activeContext
    );
  }

  /** Refresh the loop-history cache ONLY when the transcript file
   * has grown OR its mtime changed since the last scan. Idle
   * sessions pay only a `statSync`. Active sessions pay the 256 KB
   * tail read once per user turn (roughly once per minute). The
   * mtime check guards against a rotated transcript landing on an
   * identical byte count with different contents, which would
   * otherwise reuse the stale scan indefinitely. */
  private refreshLoopHistoryIfNeeded(): void {
    const path = this.activeContext?.transcriptPath ?? null;
    if (!path) {
      this.loopHistory = null;
      this.lastScannedSize = -1;
      this.lastScannedMtimeMs = -1;
      return;
    }
    let size: number | null = null;
    let mtimeMs: number | null = null;
    try {
      const st = statSync(path);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      size = null;
      mtimeMs = null;
    }
    if (size === null || mtimeMs === null) return;
    if (
      size === this.lastScannedSize &&
      mtimeMs === this.lastScannedMtimeMs
    ) {
      return;
    }
    this.loopHistory = scanTailForCompactHistory(path);
    this.lastScannedSize = size;
    this.lastScannedMtimeMs = mtimeMs;
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
    // state). Invalidate the settings cache so the re-resolve
    // sees the post-heal file contents, then re-resolve.
    this.settingsCache = null;
    const freshRead: OverrideReadResult = this.cachedReadOverride();
    return determineUnavailableReason({
      overrideReadResult: freshRead,
      sentinelOwnedByUs: this.ownsSentinel(),
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
