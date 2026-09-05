import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { logNotifEvent } from "../engine/notifEventLog";
import { PathWatcher } from "../shared/polling/pathWatcher";
import { SESSION_TOKEN_RESCAN_MS } from "../shared/polling/pollingTimings";
import type { NonActiveCompletionTracker } from "../shared/sessionTokens/nonActiveCompletionTracker";
import {
  clearPersistedRollout,
  persistRollout,
  readPersistedRollout,
} from "./activeRolloutStore";
import { extractSessionId } from "./parsers";
import { findLatestRollout } from "./rolloutDiscovery";
import type { RolloutCandidate } from "./rolloutRanking";

/**
 * Which Codex rollout this workspace's widget follows, and whether it
 * is still growing. Owns the sessions-directory watcher, the rescan
 * cadence, the persisted pointer that survives a reload, the workspace
 * inventory from the same scan, and the byte-growth watermark that
 * feeds the freshness gate. `codexSessionTokenService.ts` reads the
 * file this names.
 */

interface RolloutGrowth {
  mtimeMs: number;
  size: number;
  grew: boolean;
}

export class ActiveRolloutTracker {
  private path: string | null;
  private lastScan = 0;
  /** Latest workspace inventory snapshot. Refreshed inside the same
   * scan that picks the active rollout, surfaced in the emitted state
   * for the multi-session tooltip line. */
  inventory: { total: number; inProgress: number } = { total: 0, inProgress: 0 };
  /** Wall-clock ms when the rollout file was last observed to grow in
   * byte size. Seeded with kernel mtime on the first poll of a new
   * rollout (so a stale file is not falsely read as live), then
   * `Date.now()` on any later poll where size grew. Feeds
   * `CodexResolvedSession.lastActivityObservedAt` - see that field for
   * why byte-growth, not kernel mtime, drives the freshness gate. */
  lastActivityObservedAt: number | null = null;
  /** Watches ~/.codex/sessions/ for new rollout files. Recursive on
   * Windows/macOS to catch date-sharded subdirs, with a fallback to
   * the poll cadence on Linux where recursive watch is unsupported.
   * The callback drops the cached path and scan stamp so the next
   * poll re-picks the newest rollout instead of riding the cache
   * through the rescan window. */
  private readonly sessionsWatcher: PathWatcher;

  constructor(
    private readonly workspacePath: string,
    private readonly nonActive: NonActiveCompletionTracker<RolloutCandidate>,
    onInvalidate: () => void
  ) {
    this.sessionsWatcher = new PathWatcher(
      () => {
        this.path = null;
        this.lastScan = 0;
        onInvalidate();
      },
      { debounceMs: 100, recursive: true }
    );
    // Re-adopt the session this workspace last tracked so a long-running
    // rollout that has aged past the discovery walk's day-window is
    // picked up again right after a reload, instead of staying invisible
    // until a fresh session is started. The store re-validates the path
    // against the workspace, so a stale or foreign pointer is ignored.
    this.path = readPersistedRollout(workspacePath);
  }

  /** The rollout to read this poll, rescanning when the cadence is
   * due or nothing is tracked. Null when no rollout exists or the
   * tracked one vanished: Codex appends to one file per session and
   * never rotates it mid-session, so a missing file means the session
   * is genuinely gone, not transiently unavailable. An aged-but-
   * present session that fell outside the discovery walk still passes
   * the existence check here, so it keeps rendering. */
  resolve(codexDir: string, now: number): string | null {
    this.sessionsWatcher.sync(join(codexDir, "sessions"));
    if (now - this.lastScan >= SESSION_TOKEN_RESCAN_MS || !this.path) {
      const result = findLatestRollout(codexDir, this.workspacePath, this.path);
      if (result.path) this.path = result.path;
      this.inventory = { total: result.total, inProgress: result.inProgress };
      this.lastScan = now;
      this.nonActive.observe(result.candidates, result.path, now);
    }
    if (!this.path || !existsSync(this.path)) {
      this.path = null;
      return null;
    }
    return this.path;
  }

  /** The service switched to `path`. Re-seeds the growth watermark on
   * the next stat so this file's kernel mtime becomes the baseline
   * rather than the prior file's freshness, logs the switch for a
   * missing-notification post-mortem, and persists the pointer so a
   * reload can re-adopt it after it ages past the discovery walk. */
  adopt(path: string, prevPath: string | null): void {
    this.lastActivityObservedAt = null;
    logNotifEvent({
      at: Date.now(),
      kind: "session-switch",
      provider: "codex",
      fromPath: prevPath,
      toPath: path,
      fromSessionId: prevPath ? extractSessionId(prevPath) : null,
      toSessionId: extractSessionId(path),
      source: "rollout-scan",
    });
    persistRollout(path);
  }

  /** Stat the rollout against the size the service last read. Null
   * when the stat fails (file mid-rotation), so the caller skips the
   * poll. */
  observeGrowth(path: string, knownSize: number): RolloutGrowth | null {
    try {
      const st = statSync(path);
      const grew = st.size !== knownSize;
      if (grew) {
        this.lastActivityObservedAt =
          this.lastActivityObservedAt === null ? st.mtimeMs : Date.now();
      }
      return { mtimeMs: st.mtimeMs, size: st.size, grew };
    } catch {
      return null;
    }
  }

  reset(): void {
    this.path = null;
    this.lastScan = 0;
    clearPersistedRollout();
    this.lastActivityObservedAt = null;
    this.sessionsWatcher.close();
  }

  close(): void {
    this.sessionsWatcher.close();
  }
}
