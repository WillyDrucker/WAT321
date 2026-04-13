import { statSync } from "node:fs";
import {
  readAutoCompactOverride,
} from "../shared/claudeSettings";
import { ARMED_OVERRIDE_VALUE } from "./backups";
import { scanForCompactMarker } from "./compactDetector";
import { healStuckOverride } from "./heal";

/**
 * Post-disarm cooldown watcher. Encapsulates the "watch for stray
 * compacts after WAT321 restored the override" behavior that used
 * to live directly inside the service's poll loop.
 *
 * Why this exists:
 *
 * After a `compact-detected` disarm, the running Claude CLI process
 * may still hold the old armed env value in its own memory and fire
 * another compact on the next turn even though we already rewrote
 * settings.json. The watcher scans the transcript for additional
 * markers during a bounded window and, if it sees one, re-runs the
 * heal path defensively and emits a `loop-detected` event so the
 * widget can tell the user to restart their Claude terminal.
 *
 * The watcher owns its own state and listener set. The service
 * calls `start`, `poll`, `stop`, and `remainingMs` without reaching
 * into any fields.
 */

export type CooldownEvent =
  | { kind: "started"; until: number }
  | { kind: "loop-detected" }
  | { kind: "cleared" };

export type CooldownListener = (event: CooldownEvent) => void;

/** How long to keep watching after a successful compact-detected
 * disarm. Long enough to see a second compact fire on the next
 * Claude turn, short enough that we are not holding the fast poll
 * cadence open indefinitely. */
export const POST_DISARM_COOLDOWN_MS = 30_000;

export class PostDisarmWatcher {
  private until = 0;
  private transcriptPath: string | null = null;
  private scanOffset = 0;
  private loopDetected = false;
  private listeners: Set<CooldownListener> = new Set();

  /** True if the watcher is currently inside its cooldown window. */
  isActive(): boolean {
    return this.until > 0;
  }

  /** Milliseconds remaining in the current cooldown window, or 0
   * if no cooldown is active. The passive availability resolver
   * uses this as the single source of truth for the cooldown red
   * condition. */
  remainingMs(): number {
    if (this.until === 0) return 0;
    const remaining = this.until - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /** True if the watcher has observed a stray compact marker since
   * the current cooldown window started. Cleared when the cooldown
   * ends or on a fresh `start()`. */
  hasLoopDetected(): boolean {
    return this.loopDetected;
  }

  subscribe(listener: CooldownListener): void {
    this.listeners.add(listener);
  }

  unsubscribe(listener: CooldownListener): void {
    this.listeners.delete(listener);
  }

  clearListeners(): void {
    this.listeners.clear();
  }

  /** Called by the service when a `compact-detected` disarm
   * completes successfully. Captures the transcript path and
   * current file size as the scan baseline, then emits a
   * `started` event so listeners can begin reacting. */
  start(transcriptPath: string): void {
    this.until = Date.now() + POST_DISARM_COOLDOWN_MS;
    this.transcriptPath = transcriptPath;
    this.loopDetected = false;
    try {
      this.scanOffset = statSync(transcriptPath).size;
    } catch {
      this.scanOffset = 0;
    }
    this.emit({ kind: "started", until: this.until });
  }

  /** Called from the service's 2 s poll loop while the cooldown is
   * active. Reads newly appended bytes of the watched transcript
   * and looks for a fresh compact-summary marker. If one appears,
   * re-runs the heal path and emits `loop-detected`. The heal
   * write is gated by a quick `readAutoCompactOverride` check so
   * an already-healthy settings file is never re-written. */
  poll(): void {
    const now = Date.now();
    if (now >= this.until) {
      this.stop();
      return;
    }
    const path = this.transcriptPath;
    if (!path) {
      this.stop();
      return;
    }
    try {
      const size = statSync(path).size;
      const outcome = scanForCompactMarker(path, this.scanOffset, size);
      this.scanOffset = outcome.nextOffset;
      if (outcome.found) {
        this.loopDetected = true;
        // Cheap check before writing: if the settings are already
        // healthy, skip the re-heal write entirely. Avoids writing
        // ~/.claude/settings.json on every stray compact if the
        // restore already landed correctly.
        const read = readAutoCompactOverride();
        if (read.kind === "present" && read.value === ARMED_OVERRIDE_VALUE) {
          healStuckOverride();
        }
        this.emit({ kind: "loop-detected" });
      }
    } catch {
      // best-effort; transcript may have been rotated
    }
  }

  /** Forcefully end the cooldown window and emit `cleared`. Called
   * from `poll` when the window expires naturally, and from the
   * service's dispose path. Idempotent when no cooldown is
   * active. */
  stop(): void {
    if (this.until === 0) return;
    this.until = 0;
    this.transcriptPath = null;
    this.scanOffset = 0;
    this.loopDetected = false;
    this.emit({ kind: "cleared" });
  }

  private emit(event: CooldownEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // listener errors must never crash the poll loop
      }
    }
  }
}
