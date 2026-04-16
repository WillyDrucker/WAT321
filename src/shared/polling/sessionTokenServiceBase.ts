import type { FSWatcher } from "node:fs";
import { watch } from "node:fs";
import type { StateListener } from "../serviceTypes";

/**
 * Shared base class for Claude and Codex session token services.
 * Owns lifecycle plumbing: state, listeners, timer, dispose,
 * subscribe/unsubscribe, rebroadcast, getLastActivityMs, the
 * never-degrade guard, and an fs.watch-based transcript watcher
 * for instant change detection.
 *
 * The watcher uses the OS kernel's file-change notification
 * (ReadDirectoryChangesW on Windows, inotify on Linux, FSEvents
 * on macOS) so it consumes zero CPU while idle. The timer-based
 * fallback poll runs at a relaxed cadence and serves only as a
 * safety net for session discovery and any missed watcher events.
 *
 * Provider-specific logic (poll, setOkState, caches, transcript
 * discovery) stays in the concrete subclass. The base class never
 * imports provider-specific types or parsers.
 *
 * `rebroadcast()` resets `cachedTranscriptSize` to force a full file
 * re-read on the next poll, ensuring display-mode toggles
 * pick up fresh data.
 */
export abstract class SessionTokenServiceBase<TState extends { status: string }> {
  protected state: TState;
  private listeners = new Set<StateListener<TState>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  protected disposed = false;
  protected readonly workspacePath: string;
  protected cachedTranscriptPath = "";
  protected cachedTranscriptSize = 0;

  /** fs.watch handle for the active transcript file. Fires on any
   * file change, triggering an immediate poll instead of waiting
   * for the next fallback interval. Null when no transcript is
   * resolved or when fs.watch is not available. */
  private transcriptWatcher: FSWatcher | null = null;
  private watchedPath = "";
  private watchDebounce: ReturnType<typeof setTimeout> | null = null;

  /** Debounce window for fs.watch events. Coalesces rapid
   * successive events (common on Windows where a single write can
   * fire 2-3 events) into one poll. 50ms is imperceptible but
   * prevents redundant work. */
  private static readonly WATCH_DEBOUNCE_MS = 50;

  constructor(
    workspacePath: string,
    initialState: TState,
    private readonly pollIntervalMs: number
  ) {
    this.workspacePath = workspacePath.replace(/\\/g, "/");
    this.state = initialState;
  }

  start(): void {
    this.poll();
    this.syncWatcher();
    this.timer = setInterval(() => {
      this.poll();
      this.syncWatcher();
    }, this.pollIntervalMs);
  }

  subscribe(listener: StateListener<TState>): void {
    this.listeners.add(listener);
    listener(this.state);
  }

  unsubscribe(listener: StateListener<TState>): void {
    this.listeners.delete(listener);
  }

  /** Re-emit current state to all listeners and force a full
   * file re-read on the next poll. Subclasses that maintain
   * additional caches should override and call `super.rebroadcast()`
   * after clearing their own caches. */
  rebroadcast(): void {
    this.cachedTranscriptSize = 0;
    for (const fn of this.listeners) fn(this.state);
  }

  /** Current transcript / rollout file path, or null if no session
   * has been resolved yet. Used by the notification bridge to read
   * the response preview on context-change events. */
  getActiveTranscriptPath(): string | null {
    return this.cachedTranscriptPath || null;
  }

  /** Most recent active-session mtime, or null if no session has
   * been resolved. Consumed by the usage service as the activity
   * signal that gates the kickstart out of rate-limited park.
   *
   * Uses defensive property access instead of a direct cast because
   * the base class is generic over TState and can't know the
   * concrete session shape. Both Claude and Codex subclasses have
   * `session.lastActiveAt` when status is "ok". */
  getLastActivityMs(): number | null {
    if (this.state.status !== "ok") return null;
    const session = (this.state as Record<string, unknown>).session;
    if (typeof session !== "object" || session === null) return null;
    const lastActiveAt = (session as Record<string, unknown>).lastActiveAt;
    return typeof lastActiveAt === "number" ? lastActiveAt : null;
  }

  dispose(): void {
    this.disposed = true;
    this.closeWatcher();
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  /** Start or swap the transcript watcher when the active
   * transcript path changes. Close when the path is empty (no
   * session resolved). Called after every poll so the watcher
   * tracks session switches automatically. */
  private syncWatcher(): void {
    const target = this.cachedTranscriptPath;

    // No transcript to watch - close any existing watcher.
    if (!target) {
      this.closeWatcher();
      return;
    }

    // Already watching the right file.
    if (target === this.watchedPath && this.transcriptWatcher) return;

    // Path changed - swap the watcher.
    this.closeWatcher();
    try {
      this.transcriptWatcher = watch(
        target,
        { persistent: false },
        (eventType) => this.onWatchEvent(eventType)
      );
      // Absorb post-creation errors (file deleted, permissions
      // revoked) so they don't surface as unhandled EventEmitter
      // errors. The fallback timer recreates via syncWatcher().
      this.transcriptWatcher.on("error", () => {
        this.closeWatcher();
      });
      this.watchedPath = target;
    } catch {
      // fs.watch unavailable on this path/FS. The fallback timer
      // still runs so polling continues at its normal cadence.
      this.transcriptWatcher = null;
      this.watchedPath = "";
    }
  }

  /** Handle an fs.watch event with debounce. Multiple events can
   * fire for a single write (platform-dependent). The debounce
   * coalesces them into one poll.
   *
   * A `rename` event signals the watched file was deleted,
   * replaced, or renamed. On Linux/macOS, `fs.watch` follows
   * the inode - if the file is deleted and recreated at the same
   * path, the watcher stays attached to the old (now-deleted)
   * inode and silently stops firing. Closing the watcher on
   * `rename` lets `syncWatcher()` recreate it against the new
   * file on the next debounced tick. */
  private onWatchEvent(eventType: string): void {
    if (this.disposed) return;

    if (eventType === "rename") {
      this.closeWatcher();
      // Fall through to schedule a debounced poll+sync so the
      // watcher is rebuilt against the (possibly new) file.
    }

    if (this.watchDebounce) return;
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = null;
      if (this.disposed) return;
      this.poll();
      this.syncWatcher();
    }, SessionTokenServiceBase.WATCH_DEBOUNCE_MS);
  }

  private closeWatcher(): void {
    if (this.transcriptWatcher) {
      try {
        this.transcriptWatcher.close();
      } catch {
        // best-effort
      }
      this.transcriptWatcher = null;
      this.watchedPath = "";
    }
  }

  protected setState(s: TState): void {
    if (this.disposed) return;
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  /** Set an ok state only if the session data has actually changed.
   * Uses JSON comparison to avoid manual field-by-field checks in
   * each provider's service. The `buildState` callback constructs the
   * full TState from the session object. */
  protected setOkStateIfChanged<TSession>(
    session: TSession,
    buildState: (session: TSession) => TState
  ): void {
    if (this.state.status === "ok") {
      const prevSession = (this.state as Record<string, unknown>).session;
      if (JSON.stringify(prevSession) === JSON.stringify(session)) return;
    }
    this.setState(buildState(session));
  }

  /** Whether the current state has usable data that should not be
   * degraded back to no-session on a transient poll failure. */
  protected get hasGoodData(): boolean {
    return this.state.status === "ok";
  }

  protected abstract poll(): void;
}
