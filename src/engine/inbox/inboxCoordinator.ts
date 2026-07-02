import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import * as vscode from "vscode";
import type { EventHub } from "../eventHub";
import { allInboundDirs } from "./inboxPaths";
import {
  countPendingLateReplies,
  newestLateReplyAgeMs,
} from "./inboxReader";

/**
 * Multi-target inbox coordinator. fs-watches every backend's inbound
 * dir simultaneously so a reply landing on any tier surfaces to the
 * status bar within ~50ms.
 *
 * Pattern:
 *   - One FSWatcher per inbound dir (Codex EH mailbox + each non-Codex
 *     per-client dir).
 *   - 5s polling tick as a missed-event backstop.
 *   - Single debounced `tick()` triggered by any watcher event (envelope
 *     tmp+rename produces 2-3 events - we coalesce).
 *   - Typed event emission via EventHub so subscribers (status bar,
 *     toast notifier, future widgets) react off events instead of
 *     polling.
 *
 * Lives in engine/ so adding a new backend just means populating the
 * dispatcher and inbox dirs - this coordinator picks them up via
 * `allInboundDirs()` without code changes.
 */

const TICK_INTERVAL_MS = 5000;
const WATCH_DEBOUNCE_MS = 50;

export interface InboxSnapshot {
  workspacePath: string | null;
  /** Pending envelope count across all enabled targets' inbound dirs.
   * Excludes envelopes younger than the late-reply threshold (3s)
   * so the count reflects "settled" replies the user can act on. */
  pendingCount: number;
  /** Wall-clock ms since the newest pending reply landed. Null when
   * the inbox is empty. Drives the status bar's mail-pulse arrival
   * window. */
  newestAgeMs: number | null;
}

const IDLE_SNAPSHOT: InboxSnapshot = {
  workspacePath: null,
  pendingCount: 0,
  newestAgeMs: null,
};

export class InboxCoordinator implements vscode.Disposable {
  private lastSnapshot: InboxSnapshot = IDLE_SNAPSHOT;
  private interval: ReturnType<typeof setInterval> | null = null;
  /** One fs-watch per inbound dir. Keyed by dir path so re-evaluating
   * per-tick detects a workspace change by comparing the current
   * target-dir set against the watched-dir set. */
  private watchers = new Map<string, FSWatcher>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly events: EventHub) {}

  start(): void {
    if (this.interval !== null) return;
    this.tick();
    this.interval = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  /** Recompute the inbox snapshot. Re-attaches fs-watchers when the
   * active workspace's target-dir set changes. Emits
   * `inbox.countChanged` so the status bar can refresh on any count
   * delta (arrivals and drains both move the count). */
  tick(): InboxSnapshot {
    const workspacePath =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    this.ensureWatchers(workspacePath);
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
    this.detachAll();
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

  /** Attach a watcher per inbound dir for the active workspace. Tear
   * down watchers that no longer match (workspace changed or dir was
   * removed). Lazy: retry on each tick if a dir doesn't exist yet
   * (first dispatch hasn't created it). */
  private ensureWatchers(workspacePath: string | null): void {
    const targets =
      workspacePath !== null
        ? allInboundDirs(workspacePath).map((d) => d.dir)
        : [];

    // Tear down watchers on dirs no longer in the target set.
    for (const [dir, watcher] of this.watchers) {
      if (!targets.includes(dir)) {
        try {
          watcher.close();
        } catch {
          // best-effort
        }
        this.watchers.delete(dir);
      }
    }

    if (targets.length === 0) return;

    for (const dir of targets) {
      if (this.watchers.has(dir)) continue;
      if (!existsSync(dir)) continue;
      try {
        const watched = dir;
        const w = watch(dir, { persistent: false }, (_event, filename) => {
          if (filename && !filename.toString().endsWith(".md")) return;
          if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            try {
              statSync(watched);
              this.tick();
            } catch {
              // Dir disappeared - drop this single watcher - let the
              // next tick re-evaluate the target set.
              const existing = this.watchers.get(watched);
              if (existing) {
                try {
                  existing.close();
                } catch {
                  // best-effort
                }
                this.watchers.delete(watched);
              }
            }
          }, WATCH_DEBOUNCE_MS);
        });
        w.on("error", () => {
          try {
            w.close();
          } catch {
            // best-effort
          }
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, w);
      } catch {
        // skip this dir - the next tick retries
      }
    }
  }

  private detachAll(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // best-effort
      }
    }
    this.watchers.clear();
  }
}
