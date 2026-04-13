import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ClaudeForceAutoCompactSentinel, ClaudeForceAutoCompactState } from "./types";

const POLL_INTERVAL_MS = 2_000;
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes before forced restore
const COMPACT_SIZE_RATIO = 0.25; // compact fired when size drops below 25% of baseline
const SENTINEL_PATH = join(homedir(), ".wat321", "claude-force-auto-compact-sentinel.json");
const RESTORED_DISPLAY_MS = 3_000; // how long to show "Restored" state

type Listener = (state: ClaudeForceAutoCompactState) => void;

/** Why an armed session was disarmed. Surfaced to the widget so the user
 * sees a notification explaining an unexpected restore.
 */
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
  /** Read by the widget after it sees an armed -> restored transition. */
  lastDisarmReason: DisarmReason | null = null;

  constructor() {
    // Initial state is determined on start() - constructor cannot do async work
    this.state = { status: "not-installed" };
  }

  start(): void {
    if (this.timer) return;

    // Sentinel recovery policy:
    // - If no sentinel exists -> ready
    // - If a sentinel exists AND it is within the TIMEOUT_MS freshness
    //   window, adopt it as an armed state. This handles three cases
    //   without stepping on the owning instance: (a) we just restarted
    //   and are the owner, (b) another VS Code window armed and we are
    //   a second instance opening mid-flow, (c) the extension reloaded
    //   while armed. In all three, poll() will catch the compact or
    //   the timeout and disarm.
    // - If a sentinel exists AND it is older than TIMEOUT_MS, it is a
    //   real crash leftover. Try to restore; on failure, surface the
    //   stale-sentinel error state so the user can retry manually.
    const existing = this.readSentinel();
    if (existing) {
      const age = Date.now() - existing.armedAt;
      if (age < TIMEOUT_MS) {
        // Fresh - adopt without touching the sentinel or settings
        this.setState({ status: "armed", sentinel: existing });
      } else {
        const restored = this.restoreFromSentinel(existing);
        if (restored) {
          this.setState({ status: "ready" });
        } else {
          this.setState({ status: "stale-sentinel", sentinel: existing });
        }
      }
    } else {
      this.setState({ status: "ready" });
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

  /**
   * Arm the force-auto-compact by writing the sentinel and lowering the
   * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in ~/.claude/settings.json.
   *
   * Returns true on success, false if any step failed.
   */
  /**
   * Result codes for arm(). Distinguishes "refused because something is
   * already in flight / unsafe" from "failed because of an IO error" so
   * the widget can show the user a helpful message.
   */
  arm(
    watchTranscriptPath: string,
    targetSessionId: string,
    armedOverride: string = "1"
  ):
    | { ok: true }
    | { ok: false; reason: "sentinel-exists" | "already-armed-value" | "io-error" | "settings-missing" } {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    if (!existsSync(settingsPath)) return { ok: false, reason: "settings-missing" };

    // Refuse if another arm is already in flight. Protects against a
    // second VS Code window or a stray retry overwriting the live
    // sentinel's `originalOverride` with the current (armed) value,
    // which would trap the user at the low override forever.
    if (existsSync(SENTINEL_PATH)) {
      return { ok: false, reason: "sentinel-exists" };
    }

    let settings: Record<string, unknown>;
    let originalOverride: string | null = null;
    try {
      const raw = readFileSync(settingsPath, "utf8");
      settings = JSON.parse(raw);
      const env = (settings.env as Record<string, unknown>) || {};
      const v = env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
      originalOverride =
        typeof v === "string" ? v : v === null || v === undefined ? null : String(v);
    } catch {
      return { ok: false, reason: "io-error" };
    }

    // Refuse if the override is already at the armed value. This is the
    // "1 is not the original" safety: we never capture the compact-
    // triggering value as the baseline to restore to. The user has to
    // manually restore settings first and then re-arm.
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
      settingsPath,
      originalOverride,
      armedOverride,
      watchTranscriptPath,
      baselineSize,
      armedAt: Date.now(),
      targetSessionId,
    };

    // Write sentinel FIRST so self-heal can recover even if the settings
    // write fails below.
    if (!this.writeSentinel(sentinel)) return { ok: false, reason: "io-error" };

    // Now edit settings.json with the new override value. Atomic
    // tmp+rename so a crash mid-write cannot truncate the user's
    // settings file.
    try {
      const env = (settings.env as Record<string, unknown>) || {};
      env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = armedOverride;
      settings.env = env;
      const tmp = `${settingsPath}.wat321.tmp`;
      writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
      renameSync(tmp, settingsPath);
    } catch {
      // Settings write failed - clean up the sentinel so we don't leave
      // dangling state.
      this.deleteSentinel();
      return { ok: false, reason: "io-error" };
    }

    this.setState({ status: "armed", sentinel });
    return { ok: true };
  }

  /**
   * User-initiated cancel OR automatic restore after compact detection.
   * Restores the original override and deletes the sentinel.
   *
   * Multi-instance race: if another VS Code window's service already
   * restored the sentinel, we find it gone and treat that as a
   * successful disarm on our side (the global state is correct, we just
   * missed being the one to write it).
   */
  disarm(reason: DisarmReason = "user-cancel"): boolean {
    if (this.state.status !== "armed") return false;
    const sentinel = this.state.sentinel;
    this.lastDisarmReason = reason;

    // Multi-instance race guard: if the sentinel is gone, another
    // instance already handled the restore. Just update our own state.
    if (!existsSync(SENTINEL_PATH)) {
      this.setState({ status: "restored" });
      setTimeout(() => {
        if (!this.disposed && this.state.status === "restored") {
          this.setState({ status: "ready" });
        }
      }, RESTORED_DISPLAY_MS);
      return true;
    }

    const ok = this.restoreFromSentinel(sentinel);
    if (!ok) {
      this.setState({ status: "stale-sentinel", sentinel });
      return false;
    }

    this.setState({ status: "restored" });
    // Auto-return to "ready" after a brief display of "restored"
    setTimeout(() => {
      if (!this.disposed && this.state.status === "restored") {
        this.setState({ status: "ready" });
      }
    }, RESTORED_DISPLAY_MS);
    return true;
  }

  /**
   * Static helper for external callers (the reset flow) that need to
   * honor a pre-existing sentinel before wiping ~/.wat321/. Returns a
   * discriminated outcome so the caller can tell whether it is safe to
   * proceed:
   *
   *   "no-sentinel"   - nothing to restore, safe to proceed
   *   "restored"      - sentinel found and successfully restored, safe
   *   "restore-failed" - sentinel found but restore failed. Caller
   *                     MUST NOT delete the sentinel; it is the only
   *                     record of the user's original override value
   */
  static restoreSentinelIfPresent(): "no-sentinel" | "restored" | "restore-failed" {
    const service = new ClaudeForceAutoCompactService();
    const existing = service.readSentinel();
    if (!existing) return "no-sentinel";
    const ok = service.restoreFromSentinel(existing);
    return ok ? "restored" : "restore-failed";
  }

  /**
   * Manual retry of a stale-sentinel restore. Called from the widget when
   * the user clicks on an error-state widget.
   */
  retryStaleRestore(): boolean {
    if (this.state.status !== "stale-sentinel") return false;
    const ok = this.restoreFromSentinel(this.state.sentinel);
    if (ok) {
      this.setState({ status: "ready" });
      return true;
    }
    return false;
  }

  private poll(): void {
    if (this.disposed) return;
    if (this.state.status !== "armed") return;

    const sentinel = this.state.sentinel;
    const now = Date.now();

    // Timeout failsafe: restore after TIMEOUT_MS even if compact never fired
    if (now - sentinel.armedAt > TIMEOUT_MS) {
      this.disarm("timeout");
      return;
    }

    // Session-aware: if the target Claude session's <pid>.json has
    // disappeared from ~/.claude/sessions/, the CLI that owned it has
    // exited. There is no live process left to trigger compact on, so
    // auto-disarm immediately and restore. This is the "user closed
    // the Claude terminal mid-arm" recovery path.
    if (!this.isTargetSessionStillLive(sentinel.targetSessionId)) {
      this.disarm("session-ended");
      return;
    }

    // Check the watched transcript for a dramatic size collapse
    try {
      const size = statSync(sentinel.watchTranscriptPath).size;
      if (size < sentinel.baselineSize * COMPACT_SIZE_RATIO) {
        // Compact fired!
        this.disarm("compact-detected");
        return;
      }
    } catch {
      // Transcript file may have been replaced mid-compact. If the path
      // no longer exists, treat that as "compact fired" - Claude may
      // start a new session file after compacting.
      if (!existsSync(sentinel.watchTranscriptPath)) {
        this.disarm("compact-detected");
      }
    }
  }

  /**
   * Scan ~/.claude/sessions/*.json for a live entry whose sessionId
   * matches the targeted session. Returns true if found. Used during
   * the armed poll to detect "user closed the Claude terminal" before
   * the 5-minute timeout.
   */
  private isTargetSessionStillLive(targetSessionId: string): boolean {
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
      // If we cannot read the directory at all, err on the side of
      // "still live" so we do not disarm on a transient filesystem hiccup
      return true;
    }
    return false;
  }

  private setState(s: ClaudeForceAutoCompactState): void {
    if (this.disposed) return;
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  private readSentinel(): ClaudeForceAutoCompactSentinel | null {
    if (!existsSync(SENTINEL_PATH)) return null;
    try {
      const raw = readFileSync(SENTINEL_PATH, "utf8");
      const parsed = JSON.parse(raw) as ClaudeForceAutoCompactSentinel;
      if (parsed.version !== 1) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeSentinel(sentinel: ClaudeForceAutoCompactSentinel): boolean {
    try {
      mkdirSync(join(homedir(), ".wat321"), { recursive: true });
      const tmp = SENTINEL_PATH + ".tmp";
      writeFileSync(tmp, JSON.stringify(sentinel, null, 2), "utf8");
      renameSync(tmp, SENTINEL_PATH);
      return true;
    } catch {
      return false;
    }
  }

  private deleteSentinel(): void {
    try {
      if (existsSync(SENTINEL_PATH)) unlinkSync(SENTINEL_PATH);
    } catch {
      // best-effort
    }
  }

  /**
   * Restore the original CLAUDE_AUTOCOMPACT_PCT_OVERRIDE value and
   * delete the sentinel. Returns true on success.
   */
  private restoreFromSentinel(sentinel: ClaudeForceAutoCompactSentinel): boolean {
    try {
      const raw = readFileSync(sentinel.settingsPath, "utf8");
      const settings = JSON.parse(raw) as Record<string, unknown>;
      const env = (settings.env as Record<string, unknown>) || {};

      if (sentinel.originalOverride === null) {
        delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
      } else {
        env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = sentinel.originalOverride;
      }
      settings.env = env;
      // Atomic tmp+rename so a crash mid-restore cannot truncate the
      // user's settings file. Critical: this IS the recovery path, so
      // it must not make things worse on failure.
      const tmp = `${sentinel.settingsPath}.wat321.tmp`;
      writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
      renameSync(tmp, sentinel.settingsPath);
    } catch {
      return false;
    }
    this.deleteSentinel();
    return true;
  }
}
