import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { inboxClaudeDir } from "./constants";
import { parseEnvelope } from "./envelope";
import { workspaceHash } from "./workspaceHash";

/**
 * Late-reply inbox helpers. A "late reply" is an envelope that
 * arrived in `inbox/claude/<wshash>/` AFTER its originating prompt
 * already returned (the MCP tool call timed out, the dispatcher kept
 * working, the reply eventually landed). Active prompts poll +
 * consume matching replies within 500ms, so anything lingering >5s
 * is a late reply that nothing has claimed.
 *
 * Per-workspace partition: every helper takes a workspacePath and
 * scopes to that workspace's inbox subfolder. Prevents a status bar
 * in workspace A from rendering "1 reply waiting" because workspace
 * B has a pending envelope.
 *
 * These helpers only READ. Writes (move to sent/ after retrieval,
 * TTL sweep) live in their respective callers - dispatcher for the
 * 1h safety sweep, statusBarItem for the explicit retrieve path.
 */

const LATE_REPLY_THRESHOLD_MS = 3_000;

export interface LateReply {
  filename: string;
  fullPath: string;
  body: string;
  createdAt: string;
  intent: string;
  sizeKb: number;
}

/** Milliseconds since the newest late reply landed for the given
 * workspace, or null if no pending late replies. Drives the status
 * bar's initial 5-second mail pulse on fresh arrivals. */
export function newestLateReplyAgeMs(workspacePath: string): number | null {
  const dir = inboxClaudeDir(workspaceHash(workspacePath));
  try {
    if (!existsSync(dir)) return null;
    const cutoff = Date.now() - LATE_REPLY_THRESHOLD_MS;
    let newest = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const st = statSync(join(dir, f));
        if (st.mtimeMs < cutoff && st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        // skip unreadable entries
      }
    }
    return newest === 0 ? null : Date.now() - newest;
  } catch {
    return null;
  }
}

export function countPendingLateReplies(workspacePath: string): number {
  const dir = inboxClaudeDir(workspaceHash(workspacePath));
  try {
    if (!existsSync(dir)) return 0;
    const cutoff = Date.now() - LATE_REPLY_THRESHOLD_MS;
    let count = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const st = statSync(join(dir, f));
        if (st.mtimeMs < cutoff) count++;
      } catch {
        // best-effort
      }
    }
    return count;
  } catch {
    return 0;
  }
}

export function listLateReplies(workspacePath: string): LateReply[] {
  const dir = inboxClaudeDir(workspaceHash(workspacePath));
  const out: LateReply[] = [];
  try {
    if (!existsSync(dir)) return out;
    const cutoff = Date.now() - LATE_REPLY_THRESHOLD_MS;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const p = join(dir, f);
      try {
        const st = statSync(p);
        if (st.mtimeMs >= cutoff) continue;
        const raw = readFileSync(p, "utf8");
        const env = parseEnvelope(raw);
        if (env === null) continue;
        out.push({
          filename: f,
          fullPath: p,
          body: env.body,
          createdAt: env.createdAt,
          intent: env.intent || "reply",
          sizeKb: Math.ceil(st.size / 1024),
        });
      } catch {
        // skip malformed / unreadable
      }
    }
  } catch {
    // best-effort
  }
  return out;
}
