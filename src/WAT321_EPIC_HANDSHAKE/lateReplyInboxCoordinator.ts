import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import * as vscode from "vscode";
import type { EventHub } from "../engine/eventHub";
import { inboxClaudeDir } from "./constants";
import {
  countPendingLateReplies,
  newestLateReplyAgeMs,
} from "./lateReplyInbox";
import { workspaceHash } from "./workspaceHash";

/**
 * Per-workspace late-reply inbox tracker. fs-watch on
 * `~/.wat321/epic-handshake/inbox/claude/{wsHash}/` surfaces envelope
 * arrivals + departures within ~50ms; the bridge widget reacts off
 * the typed `inbox.countChanged` event instead of polling the
 * directory every tick.
 *
 * Snapshot fields drive both the bridge widget's mail-pulse animation
 * and the toast notifier's "fresh reply landed" trigger. Cross-cutting
 * consumers (analytics, toast policy, health command) subscribe to
 * `inbox.countChanged` events instead of polling.
 *
 * Pattern mirrors `BridgeStageCoordinator`:
 *   - fs-watch for instant reactivity
 *   - 5s polling backstop for missed events / cross-instance writes
 *   - typed event emission via EventHub
 *   - snapshot() read-anytime accessor
 *
 * Lives in the EH tier because inbox state is single-tool, not
 * cross-cutting. Engine owns only the event surface (`inbox.*` in
 * eventHub); the EH tier owns the implementation and lifecycle.
 */

const TICK_INTERVAL_MS = 5000;
const WATCH_DEBOUNCE_MS = 50;

export interface InboxSnapshot {
  workspacePath: string | null;
  /** Pending envelope count for the active workspace's inbox.
   * Excludes envelopes younger than the late-reply threshold (5s) so
   * the count reflects "settled" replies the user can act on. */
  pendingCount: number;
  /** Wall-clock ms since the newest pending reply landed. Null when
   * the inbox is empty. Drives the status bar's mail-pulse arrival
   * window (initial 5s pulse + up to 3 follow-up pulses on Claude
   * turn completions, capped at 5 minutes since arrival). */
  newestAgeMs: number | null;
}

const IDLE_SNAPSHOT: InboxSnapshot = {
  workspacePath: null,
  pendingCount: 0,
  newestAgeMs: null,
};

export class LateReplyInboxCoordinator implements vscode.Disposable {
  private lastSnapshot: InboxSnapshot = IDLE_SNAPSHOT;
  private interval: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private watchedDir: string | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly events: EventHub) {}

  start(): void {
    if (this.interval !== null) return;
    this.tick();
    this.interval = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  /** Recompute the inbox snapshot. Re-attaches fs-watch when the
   * active workspace changes. Emits `inbox.countChanged` only when
   * the pending count actually transitions. */
  tick(): InboxSnapshot {
    const workspacePath =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    this.ensureWatcher(workspacePath);
    const next = this.compute(workspacePath);
    const prev = this.lastSnapshot;
    this.lastSnapshot = next;
    if (prev.pendingCount !== next.pendingCount) {
      this.events.emit("inbox.countChanged", {
        from: prev.pendingCount,
        to: next.pendingCount,
        workspacePath: next.workspacePath,
      });
    }
    return next;
  }

  snapshot(): InboxSnapshot {
    return this.lastSnapshot;
  }

  dispose(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.detachWatcher();
    this.lastSnapshot = IDLE_SNAPSHOT;
  }

  private compute(workspacePath: string | null): InboxSnapshot {
    if (workspacePath === null) {
      return { ...IDLE_SNAPSHOT };
    }
    return {
      workspacePath,
      pendingCount: countPendingLateReplies(workspacePath),
      newestAgeMs: newestLateReplyAgeMs(workspacePath),
    };
  }

  /** Attach fs-watch on the active workspace's inbox dir. Detaches +
   * re-attaches when the workspace changes. Lazy: if the inbox dir
   * doesn't exist yet (first prompt hasn't fired), retries on each
   * tick once the dispatcher creates it. */
  private ensureWatcher(workspacePath: string | null): void {
    const targetDir =
      workspacePath !== null
        ? inboxClaudeDir(workspaceHash(workspacePath))
        : null;
    if (targetDir === this.watchedDir) return;
    this.detachWatcher();
    this.watchedDir = targetDir;
    if (targetDir === null) return;
    if (!existsSync(targetDir)) return;
    try {
      const watched = targetDir;
      this.watcher = watch(targetDir, { persistent: false }, (_event, filename) => {
        // Only react to envelope files. Ignore stray editor temp
        // files or sentinels that may appear in the same dir.
        if (filename && !filename.toString().endsWith(".md")) return;
        // Coalesce burst writes (envelope tmp+rename triggers 2-3
        // events in quick succession).
        if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          // Stat the dir to confirm it still exists; if removed
          // (workspace reset), detach and let the next tick re-evaluate.
          try {
            statSync(watched);
            this.tick();
          } catch {
            this.detachWatcher();
            this.watchedDir = null;
          }
        }, WATCH_DEBOUNCE_MS);
      });
      this.watcher.on("error", () => this.detachWatcher());
    } catch {
      this.watcher = null;
    }
  }

  private detachWatcher(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher !== null) {
      try {
        this.watcher.close();
      } catch {
        // best-effort
      }
      this.watcher = null;
    }
  }
}
