import { existsSync, statSync } from "fs";
import type {
  ClaudeForceAutoCompactSentinel,
  ClaudeForceAutoCompactState,
} from "./types";
import {
  readAutoCompactOverride,
  SETTINGS_PATH,
  writeAutoCompactOverride,
} from "../shared/claudeSettings";
import {
  deleteSentinel,
  readSentinel,
  SENTINEL_PATH,
  writeSentinel,
} from "./sentinel";
import {
  ARMED_OVERRIDE_VALUE,
  healStuckOverride,
  type HealResult,
  safeRestoreValue,
} from "./heal";
import { scanForCompactMarker } from "./compactDetector";
import { isTargetSessionStillLive } from "./sessionLiveness";

const POLL_INTERVAL_MS = 2_000;
// Short failsafe: one Claude turn fires compact within seconds. If the
// marker never appears within this window, something is wrong and we
// restore to keep the user out of a compact loop.
const TIMEOUT_MS = 45_000;
const RESTORED_DISPLAY_MS = 3_000;

type Listener = (state: ClaudeForceAutoCompactState) => void;

/** Why an armed session was disarmed. Surfaced to the widget so the user
 * sees a notification explaining an unexpected restore. */
export type DisarmReason =
  | "user-cancel"
  | "compact-detected"
  | "timeout"
  | "session-ended"
  | "session-switched"
  | "adopted-restored";

export class ClaudeForceAutoCompactService {
  private state: ClaudeForceAutoCompactState;
  private listeners: Set<Listener> = new Set();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  /** Rolling offset into the watched transcript for compact-marker
   * scanning. Reset to `baselineSize` on entry to the armed state,
   * advanced on each poll. */
  private armedScanOffset = 0;
  /** Read by the widget after it sees an armed -> restored transition. */
  lastDisarmReason: DisarmReason | null = null;

  constructor() {
    this.state = { status: "not-installed" };
  }

  start(): void {
    if (this.timer) return;

    // Sentinel recovery policy:
    // - Fresh sentinel (age < TIMEOUT_MS): legitimate in-flight arm,
    //   adopt without touching settings. poll() catches compact/timeout.
    // - No sentinel OR stale sentinel: run healStuckOverride as the
    //   startup failsafe. It inspects settings.json directly and will
    //   restore any override stuck at "1" using the sentinel's original
    //   value (if trustworthy) or the Claude default.
    // - If heal cannot write AND we still have a stale sentinel on
    //   disk, park in stale-sentinel state so the widget shows an
    //   error and the user can retry via click or Reset WAT321.
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

    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  subscribe(listener: Listener): void {
    this.listeners.add(listener);
    listener(this.state);
  }

  unsubscribe(listener: Listener): void {
    this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  /** Reset-as-failsafe and startup check. Delegates to the shared
   * heal module so every recovery path uses the same logic. */
  static healStuckOverride(): HealResult {
    return healStuckOverride();
  }

  /** Arm the force-auto-compact. Writes the sentinel first, then lowers
   * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in `~/.claude/settings.json`.
   * Rolls back the sentinel on settings-write failure so we never leave
   * a dangling record. */
  arm(
    watchTranscriptPath: string,
    targetSessionId: string,
    armedOverride: string = ARMED_OVERRIDE_VALUE
  ):
    | { ok: true }
    | {
        ok: false;
        reason:
          | "sentinel-exists"
          | "already-armed-value"
          | "io-error"
          | "settings-missing";
      } {
    // Refuse if another arm is already in flight.
    if (existsSync(SENTINEL_PATH)) {
      return { ok: false, reason: "sentinel-exists" };
    }

    // Read the current override through the discriminated reader so
    // we can distinguish "file missing" / "file unreadable" / "file
    // OK". An unreadable settings file must NOT be captured as
    // `null` original because that would bake the wrong assumption
    // into the sentinel on disk.
    const readResult = readAutoCompactOverride();
    if (readResult.kind === "missing") {
      return { ok: false, reason: "settings-missing" };
    }
    if (readResult.kind === "io-error") {
      return { ok: false, reason: "io-error" };
    }
    const originalOverride = readResult.value;

    // Refuse if the override is already at the armed value. The user
    // can run Reset WAT321 (which heals the stuck value) and retry.
    if (originalOverride === armedOverride) {
      return { ok: false, reason: "already-armed-value" };
    }

    let baselineSize = 0;
    try {
      baselineSize = statSync(watchTranscriptPath).size;
    } catch {
      return { ok: false, reason: "io-error" };
    }

    const sentinel: ClaudeForceAutoCompactSentinel = {
      version: 1,
      settingsPath: SETTINGS_PATH,
      originalOverride,
      armedOverride,
      watchTranscriptPath,
      baselineSize,
      armedAt: Date.now(),
      targetSessionId,
    };

    if (!writeSentinel(sentinel)) return { ok: false, reason: "io-error" };

    if (!writeAutoCompactOverride(armedOverride)) {
      deleteSentinel();
      return { ok: false, reason: "io-error" };
    }

    this.setState({ status: "armed", sentinel });
    return { ok: true };
  }

  /** User-initiated cancel OR automatic restore after compact detection.
   * Multi-instance race: if another VS Code window's service already
   * restored the sentinel, we find it gone and treat that as a
   * successful disarm on our side. */
  disarm(reason: DisarmReason = "user-cancel"): boolean {
    if (this.state.status !== "armed") return false;
    const sentinel = this.state.sentinel;
    this.lastDisarmReason = reason;

    if (!existsSync(SENTINEL_PATH)) {
      this.flashRestored();
      return true;
    }

    if (!this.restoreFromSentinel(sentinel)) {
      this.setState({ status: "stale-sentinel", sentinel });
      return false;
    }

    this.flashRestored();
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
    if (this.state.status !== "armed") return;

    const sentinel = this.state.sentinel;
    const now = Date.now();

    // External disarm detection: if the sentinel file is gone while
    // we still think we are armed, some other actor has already
    // restored the override and cleaned up on disk. Typical sources:
    //   - Reset WAT321 ran `healStuckOverride` and deleted it
    //   - Another VS Code window observed compact first and disarmed
    //   - User manually removed the sentinel
    // Flash restored and return to ready within the next 2s poll
    // tick instead of waiting for the 45s timeout. We suppress the
    // disarm notification (`lastDisarmReason = null`) because the
    // user already knows what they just did - a "Auto-compact fired"
    // toast after hitting Reset would be misleading.
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

  private setState(s: ClaudeForceAutoCompactState): void {
    if (this.disposed) return;
    // Reset the rolling compact-marker scan offset on any entry into
    // the armed state (fresh arm OR adoption from a sentinel after an
    // extension reload). Starting at `baselineSize` means we only scan
    // bytes appended after arming - older compact markers from earlier
    // in the same jsonl are correctly ignored.
    if (s.status === "armed" && this.state.status !== "armed") {
      this.armedScanOffset = s.sentinel.baselineSize;
    }
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  private flashRestored(): void {
    this.setState({ status: "restored" });
    setTimeout(() => {
      if (!this.disposed && this.state.status === "restored") {
        this.setState({ status: "ready" });
      }
    }, RESTORED_DISPLAY_MS);
  }

  /** Restore the original `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` value and
   * delete the sentinel. Uses `safeRestoreValue` so a corrupt sentinel
   * whose `originalOverride` is itself "1" cannot trap the user at the
   * armed value. */
  private restoreFromSentinel(
    sentinel: ClaudeForceAutoCompactSentinel
  ): boolean {
    const target = safeRestoreValue(sentinel.originalOverride);
    if (!writeAutoCompactOverride(target)) return false;
    deleteSentinel();
    return true;
  }
}
