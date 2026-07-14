import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { WAT321_ROOT } from "../wat321Paths";

/**
 * Cross-window dedup for completion notifications. Each completion is
 * keyed by `<sessionId>-<bucketedCompletionMs>` - concurrent VS Code
 * windows race to create the same tag file and the `wx` flag picks
 * exactly one winner. Sweeps stale tags on each claim.
 *
 * The tag directory is GLOBAL (`~/.wat321/fired-notifications/`), not
 * per-client. This is load-bearing. Keying it off `clientStateDir()`
 * partitioned the tags by workspace hash, so two windows on different
 * workspaces could never see each other's claim - both won, both
 * delivered, and the user got two toasts for one completion. That is
 * not a corner case: a folderless window (`workspaceId()` -> "default")
 * falls back to the globally-newest transcript, so it shadows whichever
 * project is currently active and doubles every toast that project
 * fires. Nothing here needs workspace scoping - `sessionId` is a
 * transcript basename, which is globally unique on its own.
 *
 * Whichever window wins the race delivers, and the user sees exactly
 * one toast. Which window that is does not matter: the toast content is
 * derived from the transcript, not from the window that read it.
 */

/** Two windows firing within this window collapse to the same tag.
 * Wide enough to absorb cross-window skew, narrow enough that two
 * legitimately distinct turns on the same session never collide.
 *
 * Callers MUST pass a completion timestamp that is a property of the
 * completion itself (the transcript mtime), not the observing window's
 * wall clock. Windows poll on independent cadences and can observe the
 * same completion many seconds apart - bucketing two such observations
 * straddles the boundary often enough that this gate would leak. */
const DEDUP_BUCKET_MS = 10_000;
/** Tags older than this are unlinked on the next claim sweep so the
 * tag directory stays bounded under steady load. */
const DEDUP_RETENTION_MS = 60_000;
const DEDUP_DIR_NAME = "fired-notifications";

function dedupDir(): string {
  return join(WAT321_ROOT, DEDUP_DIR_NAME);
}

function ensureDir(): void {
  try {
    mkdirSync(dedupDir(), { recursive: true });
  } catch {
    // best-effort
  }
}

/** Sanitize a sessionId into a filesystem-safe tag fragment. The
 * Claude transcript path's UUID and Codex's rollout-* basename are
 * both safe by construction, but `replace` here makes the helper
 * robust to any future identifier shape. */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]/g, "_");
}

/** Try to claim the right to fire a notification for this session +
 * completion-time bucket. Returns true if this window owns the fire
 * (any concurrent windows on the same workspace will see false for
 * the same bucket), false otherwise. `wx` create flag is the atomic
 * primitive - first writer to the path wins. */
export function tryClaimNotification(
  sessionId: string,
  completionMs: number
): { claimed: boolean; bucket: number } {
  ensureDir();
  const bucket = Math.floor(completionMs / DEDUP_BUCKET_MS) * DEDUP_BUCKET_MS;
  const tag = `${sanitize(sessionId)}-${bucket}`;
  const tagPath = join(dedupDir(), tag);
  let claimed = false;
  try {
    writeFileSync(tagPath, "", { flag: "wx" });
    claimed = true;
  } catch {
    // EEXIST means another window already claimed this bucket. Any
    // other write error (permission, disk full) also lands here. We
    // suppress delivery in both cases because we cannot prove
    // exclusive ownership. The user sees one fewer notification, not
    // two duplicates.
  }
  sweepStale();
  return { claimed, bucket };
}

function sweepStale(): void {
  try {
    const cutoff = Date.now() - DEDUP_RETENTION_MS;
    const files = readdirSync(dedupDir());
    for (const f of files) {
      const full = join(dedupDir(), f);
      try {
        const st = statSync(full);
        if (st.mtimeMs < cutoff) unlinkSync(full);
      } catch {
        // best-effort - a file that vanished between readdir and
        // stat is fine, we wanted it gone anyway.
      }
    }
  } catch {
    // best-effort
  }
}
