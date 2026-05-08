import {
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Background housekeeping for the Epic Handshake channel.
 *
 * Sent envelopes have no downstream consumer - the bridge
 * conversation lives in Claude's transcript, not the filesystem. The
 * 5-minute TTL prevents the sent folder from growing unbounded
 * across long sessions.
 *
 * Clipboard-staged attachments get a short TTL too: stale images
 * surviving across turns would burn disk and could be misinterpreted
 * by a later prompt that references the path generically.
 */

export const SENT_TTL_MS = 5 * 60 * 1000;

export function purgeOldSent(sentClaudeDir) {
  try {
    const cutoff = Date.now() - SENT_TTL_MS;
    if (!existsSync(sentClaudeDir)) return;
    for (const f of readdirSync(sentClaudeDir)) {
      const p = join(sentClaudeDir, f);
      try {
        const st = statSync(p);
        if (st.mtimeMs < cutoff) unlinkSync(p);
      } catch {
        // best-effort
      }
    }
  } catch {
    // never throw from housekeeping
  }
}

/** Sweep clipboard-staged images older than the TTL. The stage helper
 * sweeps before staging too, so cleanup pressure is high regardless
 * of which side acts first. */
export function sweepStaleAttachments(attachmentsDir, ttlMs) {
  try {
    if (!existsSync(attachmentsDir)) return;
    const cutoff = Date.now() - ttlMs;
    for (const f of readdirSync(attachmentsDir)) {
      const p = join(attachmentsDir, f);
      try {
        const st = statSync(p);
        if (st.mtimeMs < cutoff) unlinkSync(p);
      } catch {
        // best-effort
      }
    }
  } catch {
    // never throw from housekeeping
  }
}
