import type { FSWatcher } from "node:fs";
import { existsSync, watch } from "node:fs";

/**
 * Shared fs.watch wrapper for directories and files.
 *
 * Uses the OS kernel's file-change notification (ReadDirectoryChangesW
 * on Windows, inotify on Linux, FSEvents on macOS) so it consumes
 * zero CPU while idle. Falls back gracefully when fs.watch is not
 * available - the caller's poll timer serves as the safety net.
 *
 * Lifecycle: call `sync(path)` after each poll to start/swap/close
 * the watcher as the target path changes. Call `close()` on dispose.
 *
 * Rename handling: on Linux / macOS, `fs.watch` follows the inode.
 * If the watched file is deleted and recreated at the same path
 * (a common pattern for atomic writes via tmp+rename), the watcher
 * stays attached to the old now-deleted inode and silently stops
 * firing. Setting `resetOnRename: true` closes the watcher on a
 * rename event so the next `sync()` call rebuilds it against the
 * new file.
 */
export interface PathWatcherOptions {
  debounceMs?: number;
  recursive?: boolean;
  resetOnRename?: boolean;
}

export class PathWatcher {
  private watcher: FSWatcher | null = null;
  private watchedPath = "";
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly recursive: boolean;
  private readonly resetOnRename: boolean;

  constructor(
    private readonly onChange: () => void,
    options: PathWatcherOptions = {}
  ) {
    this.debounceMs = options.debounceMs ?? 100;
    this.recursive = options.recursive ?? false;
    this.resetOnRename = options.resetOnRename ?? false;
  }

  /** Start or swap the watcher when the target path changes. Close
   * when the path is empty or the target no longer exists. Safe to
   * call on every poll cycle - no-ops when already watching the
   * right path. */
  sync(path: string): void {
    if (!path || !existsSync(path)) {
      this.close();
      return;
    }
    if (path === this.watchedPath && this.watcher) return;

    this.close();
    try {
      this.watcher = watch(
        path,
        { persistent: false, recursive: this.recursive },
        (eventType) => this.onEvent(eventType)
      );
      this.watcher.on("error", () => this.close());
      this.watchedPath = path;
    } catch {
      this.watcher = null;
      this.watchedPath = "";
    }
  }

  close(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // best-effort
      }
      this.watcher = null;
      this.watchedPath = "";
    }
  }

  private onEvent(eventType: string): void {
    if (this.resetOnRename && eventType === "rename") {
      // Drop the dead inode. Next sync() call rebuilds the watcher.
      this.close();
    }
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.onChange();
    }, this.debounceMs);
  }
}
