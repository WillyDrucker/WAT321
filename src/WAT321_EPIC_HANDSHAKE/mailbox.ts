import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { EpicHandshakeLogger } from "./types";

/**
 * File-housekeeping helpers for the dispatcher's per-workspace
 * inbox/sent folders. Pure functions over directory paths - no
 * dispatcher state and no class membership.
 *
 * Two TTLs apply:
 *   - sent/codex/  - 5 minute sweep. Delivered envelopes have no
 *     downstream consumer (conversation lives in Claude's own
 *     transcript), so we just bound disk footprint.
 *   - inbox/claude/ - 1 hour sweep for stale late replies. A user
 *     who walks away should not return to unbounded mail; 1h is
 *     long enough that a useful reply had real chances to be seen.
 */

const SENT_TTL_MS = 5 * 60 * 1000;
const STALE_INBOX_TTL_MS = 60 * 60 * 1000;

/** Remove sent/codex/ envelopes older than the TTL, then run the
 * stale-inbox sweep. Best-effort throughout; never throws. */
export function purgeSent(opts: {
  sentCodex: string;
  inboxClaude: string;
  sentClaude: string;
  logger: EpicHandshakeLogger;
}): void {
  try {
    const cutoff = Date.now() - SENT_TTL_MS;
    if (existsSync(opts.sentCodex)) {
      for (const f of readdirSync(opts.sentCodex)) {
        const p = join(opts.sentCodex, f);
        try {
          const st = statSync(p);
          if (st.mtimeMs < cutoff) unlinkSync(p);
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // never throw from housekeeping
  }
  sweepStaleInboxMail(opts);
}

/** Move any envelope in inbox/claude/ older than 1 hour to the
 * sent/claude/ archive. Safety floor for the late-reply flow:
 * normally a prompt via collectLateReplies consumes pending mail
 * on the user's next bridge invocation, or the status-bar menu
 * retrieves it. */
export function sweepStaleInboxMail(opts: {
  inboxClaude: string;
  sentClaude: string;
  logger: EpicHandshakeLogger;
}): void {
  try {
    if (!existsSync(opts.inboxClaude)) return;
    const cutoff = Date.now() - STALE_INBOX_TTL_MS;
    for (const f of readdirSync(opts.inboxClaude)) {
      if (!f.endsWith(".md")) continue;
      const src = join(opts.inboxClaude, f);
      try {
        const st = statSync(src);
        if (st.mtimeMs >= cutoff) continue;
        if (!existsSync(opts.sentClaude)) {
          mkdirSync(opts.sentClaude, { recursive: true });
        }
        renameSync(src, join(opts.sentClaude, f));
        opts.logger.info(`swept stale late reply ${f} (1h TTL)`);
      } catch {
        // best-effort per file
      }
    }
  } catch {
    // never throw from housekeeping
  }
}

/** Move a delivered codex-side envelope into sent/. Falls back to
 * unlink if the rename fails (cross-device, permission, etc.) so
 * the inbox does not retain processed envelopes that would re-
 * trigger the watcher on the next debounce. */
export function moveToSent(srcPath: string, sentDir: string): void {
  const filename = srcPath.split(/[\\/]/).pop() || "";
  const dest = join(sentDir, filename);
  try {
    renameSync(srcPath, dest);
  } catch {
    try {
      unlinkSync(srcPath);
    } catch {
      // best-effort
    }
  }
}
