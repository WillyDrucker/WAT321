import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readAutoCompactOverride,
  SETTINGS_PATH,
  writeAutoCompactOverride,
} from "../shared/claudeSettings";
import {
  ARMED_OVERRIDE_VALUE,
  maybeCaptureInstallSnapshot,
  rotateArmBackup,
} from "./backups";
import {
  ACTIVE_POLL_INTERVAL_MS,
  IDLE_POLL_INTERVAL_MS,
  RESTORED_DISPLAY_MS,
  TIMEOUT_MS,
} from "./constants";
import { scanForCompactMarker } from "./compactDetector";
import {
  healStuckOverride,
  safeRestoreValue,
  type HealResult,
} from "./heal";
import {
  PassiveAvailabilityTracker,
} from "./passiveAvailability";
import type { ActiveContextInfo } from "./preflightGate";
import {
  PostDisarmWatcher,
  type CooldownEvent,
  type CooldownListener,
} from "./postDisarmWatcher";
import {
  deleteSentinel,
  readSentinel,
  SENTINEL_PATH,
  writeSentinel,
} from "./sentinel";
import type {
  ClaudeForceAutoCompactSentinel,
  ClaudeForceAutoCompactState,
  DisarmReason,
  UnavailableReason,
} from "./types";

/** Scan `~/.claude/sessions/*.json` for a live entry whose `sessionId`
 * matches the targeted session. Returns `true` if found. Errs on the
 * side of "still live" if the sessions directory itself cannot be
 * read, so a transient filesystem hiccup does not cause a spurious
 * disarm. Inlined from the former `sessionLiveness.ts` - there is
 * exactly one caller (pollArmed below) and the helper is small. */
function isTargetSessionStillLive(targetSessionId: string): boolean {
  const sessionsDir = join(homedir(), ".claude", "sessions");
  if (!existsSync(sessionsDir)) return false;

  try {
    const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = readFileSync(join(sessionsDir, file), "utf8");
        const entry = JSON.parse(raw) as { sessionId?: string };
        if (entry.sessionId === targetSessionId) return true;
      } catch {
        // skip malformed entries
      }
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * Claude Force Auto-Compact service. Owns the state machine
 * (not-installed -> ready -> armed -> restored -> ready, plus
 * stale-sentinel and unavailable branches) and the user-facing
 * arm/disarm/retry actions. Delegates availability tracking and
 * post-disarm watching to the two sibling modules:
 *
 *   - `PassiveAvailabilityTracker` owns the idle/snap/forced
 *     resolver paths, the auto-repair policy, and the size-delta
 *     cache. The service calls it for ready<->unavailable
 *     transitions and click-to-repair requests.
 *
 *   - `PostDisarmWatcher` owns the cooldown window that follows a
 *     compact-detected disarm, including the stray-compact
 *     re-heal and the `loop-detected` event fan-out.
 *
 * The service itself stays focused on the state machine, the
 * armed-state rolling scan, and the poll scheduler.
 */

type Listener = (state: ClaudeForceAutoCompactState) => void;

export type ArmResult =
  | { ok: true }
  | { ok: false; reason: string; message: string };

// Re-export cooldown types so widget consumers can import from
// service.ts and stay decoupled from the watcher module.
export type { CooldownEvent, CooldownListener };

export class ClaudeForceAutoCompactService {
  private state: ClaudeForceAutoCompactState = { status: "not-installed" };
  private listeners: Set<Listener> = new Set();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Handle for the 3-second `restored -> ready` flash transition.
   * Tracked so `dispose()` can cancel it and we don't hold a
   * closure over `this` for 3 seconds on rapid dispose/restart. */
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Rolling offset into the watched transcript for compact-marker
   * scanning during the armed state. Reset to `baselineSize` on
   * entry to armed, advanced on each poll. */
  private armedScanOffset = 0;
  /** Set on disarm, drained by the widget via `consumeLastDisarmReason`
   * after it sees an armed -> restored transition. Private so callers
   * cannot mutate it directly - the consume contract guarantees a
   * second read returns null. */
  private lastDisarmReason: DisarmReason | null = null;

  /** Drain the last disarm reason. Returns the reason once and clears
   * it so a subsequent read returns null. The widget calls this on
   * every armed -> restored transition to surface the right toast. */
  consumeLastDisarmReason(): DisarmReason | null {
    const reason = this.lastDisarmReason;
    this.lastDisarmReason = null;
    return reason;
  }

  private passive = new PassiveAvailabilityTracker(
    () => this.state.status === "armed"
  );
  private cooldown = new PostDisarmWatcher();

  start(): void {
    if (this.timer) return;

    // Sentinel recovery policy:
    // - Fresh sentinel (age < TIMEOUT_MS): legitimate in-flight arm,
    //   adopt without touching settings. poll() catches compact or
    //   timeout.
    // - No sentinel OR stale sentinel: run healStuckOverride as the
    //   startup failsafe. It inspects settings.json directly and
    //   will restore any override stuck at "1" using the sentinel's
    //   original value, newest arm backup, install snapshot, or the
    //   Claude default - in that order.
    // - If heal cannot write AND we still have a stale sentinel,
    //   park in stale-sentinel state so the widget shows an error
    //   and the user can retry via click or Reset WAT321.
    // - After heal runs, attempt to capture the install snapshot.
    //   maybeCaptureInstallSnapshot is a no-op if the file already
    //   exists OR if the current override is still poisoned.
    const existing = readSentinel();
    if (existing && Date.now() - existing.armedAt < TIMEOUT_MS) {
      this.setState({ status: "armed", sentinel: existing });
    } else {
      const result = healStuckOverride();
      if (result === "io-error" && existing) {
        this.setState({ status: "stale-sentinel", sentinel: existing });
      } else {
        this.setState({ status: "ready" });
      }
    }
    maybeCaptureInstallSnapshot();

    this.scheduleNextPoll();
  }

  subscribe(listener: Listener): void {
    this.listeners.add(listener);
    listener(this.state);
  }

  unsubscribe(listener: Listener): void {
    this.listeners.delete(listener);
  }

  subscribeCooldown(listener: CooldownListener): void {
    this.cooldown.subscribe(listener);
  }

  unsubscribeCooldown(listener: CooldownListener): void {
    this.cooldown.unsubscribe(listener);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
    this.listeners.clear();
    this.cooldown.clearListeners();
  }

  /** Re-emit current state to all listeners without advancing the
   * poll loop or touching any external resource. Used by the
   * display-mode change handler so the widget re-renders with the
   * new mode. */
  rebroadcast(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  /** Reset-as-failsafe and startup check. Delegates to the shared
   * heal module so every recovery path uses the same logic. */
  static healStuckOverride(): HealResult {
    return healStuckOverride();
  }

  /** Widget hook so the service knows the current live Claude
   * session's context and transcript path. The context fraction
   * feeds the primary arm gate; the transcript path feeds the
   * armed-state rolling scan, the cooldown watcher, and the
   * backup loop-detection scan. Pass `null` when no live Claude
   * session is available. */
  setActiveContext(ctx: ActiveContextInfo | null): void {
    this.passive.setActiveContext(ctx);
  }

  /** Widget-called entry point for snap checks on session token
   * updates and click-time state refreshes. Uses the cached
   * `ActiveContextInfo` so the common path is a handful of
   * in-memory comparisons plus one settings read. See
   * `PassiveAvailabilityTracker.resolve`. */
  snapCheckAvailability(): UnavailableReason | null {
    if (
      this.state.status !== "ready" &&
      this.state.status !== "unavailable"
    ) {
      return null;
    }
    const reason = this.passive.resolve();
    this.applyAvailability(reason);
    return reason;
  }

  /** Widget-called entry point for the click-to-repair button on
   * clickable unavailable reasons (`settings-stuck-at-armed`,
   * `settings-io-error`). Bypasses the auto-heal cooldown and
   * the context gate - this is explicit user intent to fix a
   * stuck state regardless of where their context stands. */
  manualRepair(): UnavailableReason | null {
    if (this.state.status !== "unavailable") return null;
    const currentReason = this.state.reason;
    if (
      currentReason !== "settings-stuck-at-armed" &&
      currentReason !== "settings-io-error"
    ) {
      return currentReason;
    }
    const finalReason = this.passive.resolveForcedRepair(currentReason);
    this.applyAvailability(finalReason);
    return finalReason;
  }

  /** Arm the force-auto-compact. Writes the sentinel first, then
   * lowers `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in
   * `~/.claude/settings.json`. Rolls back the sentinel on
   * settings-write failure so we never leave a dangling record.
   * The availability resolver runs first as the final safety
   * check - the widget's grayed state already prevents most
   * click-through, but a race is still possible. */
  arm(
    watchTranscriptPath: string,
    targetSessionId: string
  ): ArmResult {
    // Run the availability resolver first as a fresh defense-in-
    // depth check. `resolveForArm` scans the transcript tail
    // fresh for the loop-detection backup. Note that this path
    // does NOT auto-heal a stuck state - it just reports it. A
    // user clicking Arm on a stuck state should have clicked the
    // grayed widget's repair path instead; we refuse here.
    const armReason = this.passive.resolveForArm();
    if (armReason !== null) {
      return {
        ok: false,
        reason: armReason,
        message:
          "Claude Force Auto-Compact is currently paused. Hover the status bar widget for details.",
      };
    }

    const read = readAutoCompactOverride();
    if (read.kind !== "present") {
      return {
        ok: false,
        reason: "io-error",
        message:
          "WAT321 lost access to your Claude settings file. Try again in a moment.",
      };
    }
    const originalOverride = read.value;
    if (originalOverride === ARMED_OVERRIDE_VALUE) {
      // Belt-and-braces: resolver should already have caught this
      // via settings-stuck-at-armed. We still guard so the sentinel
      // write cannot accidentally capture "1" as the "original".
      return {
        ok: false,
        reason: "already-armed-value",
        message:
          "WAT321 detected that CLAUDE_AUTOCOMPACT_PCT_OVERRIDE is already set to 1. WAT321 will auto-repair this within a few seconds. If the widget stays paused, hover it for options.",
      };
    }

    let baselineSize = 0;
    try {
      baselineSize = statSync(watchTranscriptPath).size;
    } catch {
      return {
        ok: false,
        reason: "io-error",
        message:
          "WAT321 could not read the Claude transcript file it expected to watch. This usually self-corrects within a few seconds. Try again in a moment.",
      };
    }

    // Rotate the arm backup ring BEFORE writing the sentinel so a
    // ring entry captures the user's original value even if the
    // subsequent sentinel or settings write fails.
    rotateArmBackup(originalOverride);

    const sentinel: ClaudeForceAutoCompactSentinel = {
      version: 1,
      settingsPath: SETTINGS_PATH,
      originalOverride,
      armedOverride: ARMED_OVERRIDE_VALUE,
      watchTranscriptPath,
      baselineSize,
      armedAt: Date.now(),
      targetSessionId,
    };

    if (!writeSentinel(sentinel)) {
      return {
        ok: false,
        reason: "io-error",
        message:
          "WAT321 could not save its arm record. Check your disk space and file permissions, then try again.",
      };
    }

    if (!writeAutoCompactOverride(ARMED_OVERRIDE_VALUE)) {
      deleteSentinel();
      return {
        ok: false,
        reason: "io-error",
        message:
          "WAT321 could not update ~/.claude/settings.json. Check that the file is not locked or read-only, then try again.",
      };
    }

    this.setState({ status: "armed", sentinel });
    return { ok: true };
  }

  /** User-initiated cancel OR automatic restore after compact
   * detection. Multi-instance race: if another VS Code window's
   * service already restored the sentinel, we find it gone and
   * treat that as a successful disarm on our side. */
  disarm(reason: DisarmReason = "user-cancel"): boolean {
    if (this.state.status !== "armed") return false;
    const sentinel = this.state.sentinel;
    this.lastDisarmReason = reason;

    if (!existsSync(SENTINEL_PATH)) {
      this.flashRestored();
      if (reason === "compact-detected") {
        this.cooldown.start(sentinel.watchTranscriptPath);
      }
      return true;
    }

    if (!this.restoreFromSentinel(sentinel)) {
      this.setState({ status: "stale-sentinel", sentinel });
      return false;
    }

    this.flashRestored();
    if (reason === "compact-detected") {
      this.cooldown.start(sentinel.watchTranscriptPath);
    }
    return true;
  }

  /** Manual retry of a stale-sentinel restore. Routes through
   * `healStuckOverride` so even a corrupt sentinel is recoverable. */
  retryStaleRestore(): boolean {
    if (this.state.status !== "stale-sentinel") return false;
    const result = healStuckOverride();
    if (result === "io-error") return false;
    this.setState({ status: "ready" });
    return true;
  }

  private poll(): void {
    if (this.disposed) return;

    if (this.state.status === "armed") {
      this.pollArmed();
      return;
    }

    if (this.cooldown.isActive()) {
      this.cooldown.poll();
    }

    if (
      this.state.status === "ready" ||
      this.state.status === "unavailable"
    ) {
      const reason = this.passive.resolve();
      this.applyAvailability(reason);
    }
  }

  private pollArmed(): void {
    if (this.state.status !== "armed") return;
    const sentinel = this.state.sentinel;
    const now = Date.now();

    // External disarm detection: another actor (Reset WAT321,
    // another VS Code window, manual sentinel deletion) may have
    // already cleaned up. Catch up within the next poll tick.
    if (!existsSync(SENTINEL_PATH)) {
      this.lastDisarmReason = null;
      this.flashRestored();
      return;
    }

    // Timeout failsafe: restore even if compact never fired.
    if (now - sentinel.armedAt > TIMEOUT_MS) {
      this.disarm("timeout");
      return;
    }

    // Session-aware: if the target CLI has exited, auto-disarm.
    if (!isTargetSessionStillLive(sentinel.targetSessionId)) {
      this.disarm("session-ended");
      return;
    }

    // Scan newly appended bytes for the compact-summary marker.
    try {
      const size = statSync(sentinel.watchTranscriptPath).size;
      const outcome = scanForCompactMarker(
        sentinel.watchTranscriptPath,
        this.armedScanOffset,
        size
      );
      this.armedScanOffset = outcome.nextOffset;
      if (outcome.found) {
        this.disarm("compact-detected");
      }
    } catch {
      // Transcript file may have been replaced mid-compact.
      if (!existsSync(sentinel.watchTranscriptPath)) {
        this.disarm("compact-detected");
      }
    }
  }

  /** Shared state transition helper used by both snap / passive /
   * forced paths. Transitions to `ready` when reason is null,
   * otherwise to `unavailable(reason)`, but only if the state
   * would actually change. */
  private applyAvailability(reason: UnavailableReason | null): void {
    if (reason === null) {
      if (this.state.status !== "ready") {
        this.setState({ status: "ready" });
      }
    } else {
      if (
        this.state.status !== "unavailable" ||
        this.state.reason !== reason
      ) {
        this.setState({ status: "unavailable", reason });
      }
    }
  }

  private setState(s: ClaudeForceAutoCompactState): void {
    if (this.disposed) return;
    // Reset the rolling compact-marker scan offset on any entry
    // into the armed state so we only scan bytes appended after
    // arming.
    if (s.status === "armed" && this.state.status !== "armed") {
      this.armedScanOffset = s.sentinel.baselineSize;
    }
    // Any clean transition into `ready` from a non-ready /
    // non-restored state resets the heal retry cooldown. The
    // cooldown is a thrash guard for a single stuck episode, not
    // a long-term lock across episodes.
    if (
      s.status === "ready" &&
      this.state.status !== "ready" &&
      this.state.status !== "restored"
    ) {
      this.passive.resetHealCooldown();
    }
    const prev = this.state;
    this.state = s;
    for (const fn of this.listeners) fn(s);
    // Reschedule the poll timer if the state transition would
    // change the chosen interval.
    if (this.chooseNextInterval(prev) !== this.chooseNextInterval(s)) {
      this.scheduleNextPoll();
    }
  }

  private flashRestored(): void {
    this.setState({ status: "restored" });
    // Cancel any prior flash timer before scheduling a new one. Also
    // tracked on `this.flashTimer` so `dispose()` can clear it and
    // release the closure-over-this. Safe to call repeatedly.
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
    }
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      if (!this.disposed && this.state.status === "restored") {
        this.setState({ status: "ready" });
      }
    }, RESTORED_DISPLAY_MS);
  }

  /** Restore the original `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` value
   * and delete the sentinel. Uses `safeRestoreValue` so a corrupt
   * sentinel whose `originalOverride` is itself "1" cannot trap
   * the user at the armed value. */
  private restoreFromSentinel(
    sentinel: ClaudeForceAutoCompactSentinel
  ): boolean {
    const target = safeRestoreValue(sentinel.originalOverride);
    if (!writeAutoCompactOverride(target)) return false;
    deleteSentinel();
    return true;
  }

  /** Select the next poll delay based on the given state. Pure
   * function of state + cooldown flag so `setState` can cheaply
   * compare before/after intervals to decide whether to
   * reschedule. */
  private chooseNextInterval(state: ClaudeForceAutoCompactState): number {
    if (state.status === "armed") return ACTIVE_POLL_INTERVAL_MS;
    if (this.cooldown.isActive()) return ACTIVE_POLL_INTERVAL_MS;
    return IDLE_POLL_INTERVAL_MS;
  }

  /** Schedule the next `poll()` call using a fresh `setTimeout`
   * at the current-state-appropriate interval.
   *
   * Duplicate-timer safety: any existing timer is cleared before
   * a new one is installed, so this method is safe to call from
   * any code path.
   *
   * Re-entrancy safety: the setTimeout callback nulls `this.timer`
   * BEFORE calling `poll()`. That lets any reschedule triggered
   * synchronously inside poll() (via setState) cleanly claim the
   * slot. After poll() returns, the callback only re-arms if
   * `this.timer` is still null, avoiding duplicate timers. */
  private scheduleNextPoll(): void {
    if (this.disposed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const delay = this.chooseNextInterval(this.state);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed) return;
      this.poll();
      if (!this.disposed && this.timer === null) {
        this.scheduleNextPoll();
      }
    }, delay);
  }
}
