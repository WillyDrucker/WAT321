import type { StateListener } from "../types";

/**
 * Shared base class for Claude and Codex session token services.
 * Owns lifecycle plumbing: state, listeners, timer, dispose,
 * subscribe/unsubscribe, rebroadcast, getLastActivityMs, and
 * the never-degrade guard.
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
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
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
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  protected setState(s: TState): void {
    if (this.disposed) return;
    this.state = s;
    for (const fn of this.listeners) fn(s);
  }

  /** Whether the current state has usable data that should not be
   * degraded back to no-session on a transient poll failure. */
  protected get hasGoodData(): boolean {
    return this.state.status === "ok";
  }

  protected abstract poll(): void;
}
