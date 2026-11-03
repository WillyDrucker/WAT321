import { readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { sentDir } from "./inboxPaths";

/**
 * Retention for the sent archives. A consumed reply or handled envelope
 * moves into its target's `sent/` folder and nothing reads it back, so
 * each folder keeps only its newest `SENT_ARCHIVE_CAP` files.
 */

const SENT_ARCHIVE_CAP = 30;

/** Trim every workspace's partition of the shared Codex reply archive,
 * plus this client's OpenCode and local archives (other clients trim
 * their own). Best-effort, never throws. */
export function pruneSentArchives(workspacePath: string | null): void {
  const dirs = [sentDir("opencode", workspacePath), sentDir("local", workspacePath)];
  // The Codex archive holds one partition per workspace hash.
  const codexRoot = dirname(sentDir("codex", workspacePath));
  try {
    for (const entry of readdirSync(codexRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(codexRoot, entry.name));
    }
  } catch {
    // no Codex archive yet
  }
  for (const dir of dirs) pruneArchive(dir);
}

/** Unlink every file past the newest `SENT_ARCHIVE_CAP`. Subfolders
 * stay untouched. */
function pruneArchive(dir: string): void {
  const files: { path: string; mtimeMs: number }[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(dir, entry.name);
      try {
        files.push({ path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        // vanished between readdir and stat
      }
    }
  } catch {
    return;
  }
  if (files.length <= SENT_ARCHIVE_CAP) return;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of files.slice(SENT_ARCHIVE_CAP)) {
    try {
      unlinkSync(stale.path);
    } catch {
      // best-effort
    }
  }
}
