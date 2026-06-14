import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { clientStateDir } from "../wat321Paths";

/**
 * Cross-window dedup for completion notifications. Each completion
 * is keyed by `<sessionId>-<bucketedCompletionMs>` - concurrent VS
 * Code windows race to create the same tag file under
 * `<clientStateDir>/fired-notifications/` and the `wx` flag picks
 * exactly one winner. Sweeps stale tags on each claim.
 */

/** Two windows firing within this window collapse to the same tag.
 * Wide enough to absorb cross-window skew, narrow enough that two
 * legitimately distinct turns on the same session never collide. */
const DEDUP_BUCKET_MS = 10_000;
/** Tags older than this are unlinked on the next claim sweep so the
 * tag directory stays bounded under steady load. */
const DEDUP_RETENTION_MS = 60_000;
const DEDUP_DIR_NAME = "fired-notifications";

function dedupDir(): string {
  return join(clientStateDir(), DEDUP_DIR_NAME);
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
