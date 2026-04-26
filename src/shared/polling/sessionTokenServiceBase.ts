import type { StateListener } from "../../engine/serviceTypes";
import { normalizePath } from "../fs/pathUtils";
import { PathWatcher } from "./pathWatcher";

/**
 * Shared base for Claude and Codex session token services.
 *
 * Owns lifecycle plumbing: state, listeners, fallback-poll timer,
 * dispose, subscribe/unsubscribe, rebroadcast, reset, and an
 * OS-level transcript watcher via `PathWatcher`.
 *
 * Watcher uses kernel file-change notifications (ReadDirectoryChangesW
 * on Windows, inotify on Linux, FSEvents on macOS) so it consumes
 * zero CPU while idle. The fallback poll timer is a safety net for
 * session discovery and any missed watcher events.
 *
 * `rebroadcast()` resets `cachedTranscriptSize` so the next poll
 * re-reads the file in full, ensuring display-mode toggles pick up
 * fresh data.
 *
 * Provider-specific logic (poll, setOkState, transcript discovery,
 * parsers) stays in the concrete subclass. The base class never
 * imports provider-specific types.
 */
const TRANSCRIPT_WATCH_DEBOUNCE_MS = 50;

export abstract class SessionTokenServiceBase<TState extends { status: string }> {
  protected state: TState;
  private listeners = new Set<StateListener<TState>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  protected disposed = false;
  protected readonly workspacePath: string;
  protected cachedTranscriptPath = "";
  protected cachedTranscriptSize = 0;

  private readonly transcriptWatcher = new PathWatcher(
    () => this.onTranscriptEvent(),
    { debounceMs: TRANSCRIPT_WATCH_DEBOUNCE_MS, resetOnRename: true }
  );

  constructor(
    workspacePath: string,
    initialState: TState,
    private readonly pollIntervalMs: number
  ) {
    this.workspacePath = normalizePath(workspacePath);
    this.state = initialState;
  }

  start(): void {
    this.poll();
    this.transcriptWatcher.sync(this.cachedTranscriptPath);
    this.timer = setInterval(() => {
      this.poll();
      this.transcriptWatcher.sync(this.cachedTranscriptPath);
    }, this.pollIntervalMs);
  }

  subscribe(listener: StateListener<TState>): void {
    this.listeners.add(listener);
    listener(this.state);
  }

  unsubscribe(listener: StateListener<TState>): void {
    this.listeners.delete(listener);
  }

  /** Re-emit current state and force a full re-read on the next
   * poll. Subclasses that maintain extra caches should override and
   * call `super.rebroadcast()` after clearing their own. */
  rebroadcast(): void {
    this.cachedTranscriptSize = 0;
    for (const fn of this.listeners) fn(this.state);
  }

  /** Current state snapshot. Used by the session-response bridge
   * and the health command. */
  getState(): TState {
    return this.state;
  }

  /** Drop cached session state and return to idle. Subclasses should
   * override to clear their own caches before calling
   * `super.reset()`. */
  reset(): void {
    this.cachedTranscriptPath = "";
    this.cachedTranscriptSize = 0;
    this.transcriptWatcher.close();
    this.setState(this.getIdleState());
  }

  protected abstract getIdleState(): TState;

  /** Active transcript / rollout path, or null if no session is
   * resolved. Consumed by the notification bridge to read the
   * response preview on context-change events. */
  getActiveTranscriptPath(): string | null {
    return this.cachedTranscriptPath || null;
  }

  /** Trigger an immediate poll + watcher sync. Called by subclass
   * discovery watchers when the sessions directory or config file
   * changes. */
  protected triggerPoll(): void {
    if (this.disposed) return;
    this.poll();
    this.transcriptWatcher.sync(this.cachedTranscriptPath);
  }

  /** Most recent active-session mtime, or null. Consumed by the
   * usage service as the activity signal that gates kickstart out
   * of rate-limited park.
   *
   * Uses defensive property access because the base class is generic
   * over TState. Both Claude and Codex subclasses have
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
    this.transcriptWatcher.close();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  private onTranscriptEvent(): void {
    if (this.disposed) return;
    this.poll();
    this.transcriptWatcher.sync(this.cachedTranscriptPath);
  }

  protected setState(s: TState): void {
    if (this.disposed) return;
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  /** Set an ok state only if the session payload actually changed.
   * JSON comparison avoids field-by-field checks in each provider's
   * service. `buildState` constructs the full TState from the
   * session object. */
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

  /** True when current state carries usable data that should not be
   * degraded back to no-session on a transient poll failure. */
  protected get hasGoodData(): boolean {
    return this.state.status === "ok";
  }

  protected abstract poll(): void;
}
