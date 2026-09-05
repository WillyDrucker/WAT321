import { readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  INBOX_CLAUDE_DIR,
  INBOX_CODEX_DIR,
  SENT_CLAUDE_DIR,
} from "../epicHandshakePaths.mjs";
import { textResult } from "../mcpResults.mjs";
import { ensureDir } from "../wat321Paths.mjs";
import { parseEnvelope } from "./envelope.mjs";

/**
 * This workspace's Codex mailbox: the `inbox/claude` partition where
 * replies land, the `inbox/codex` partition the extension's dispatcher
 * claims from, and `sent/claude` where consumed replies go. Workspace
 * partitioning at the directory level is the only inbound filter.
 * Envelopes are deliberately NOT matched on `source_session_fp`, since
 * process restarts (vsix swap, MCP reload) rotate the fingerprint and
 * any in-flight reply produced under the old value would otherwise be
 * silently ignored. Inbound match relies on the partition plus
 * `reply_to` / `chain_id`.
 */

/** A reply younger than this may belong to a wait that is still
 * polling for it, so late-reply scans leave it alone. */
const LATE_REPLY_MIN_AGE_MS = 5_000;

export function ensureMailboxDirs() {
  for (const dir of [INBOX_CLAUDE_DIR, INBOX_CODEX_DIR, SENT_CLAUDE_DIR]) {
    ensureDir(dir);
  }
}

function listInboxFiles() {
  try {
    return readdirSync(INBOX_CLAUDE_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

function readEnvelopeFile(path) {
  try {
    return parseEnvelope(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Walk inbox/claude for reply envelopes older than the active-poll
 * cutoff. Returns the matches WITHOUT moving the source files. Drain
 * variants build on this when consumption is intended. */
export function scanLateReplies() {
  const out = [];
  const cutoff = Date.now() - LATE_REPLY_MIN_AGE_MS;
  for (const f of listInboxFiles()) {
    const p = join(INBOX_CLAUDE_DIR, f);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.mtimeMs >= cutoff) continue;
    const parsed = readEnvelopeFile(p);
    if (!parsed) continue;
    out.push({
      filename: f,
      sourcePath: p,
      body: parsed.body,
      createdAt: parsed.fields.created_at,
    });
  }
  return out;
}

/** Late-reply preamble for an active dispatch, without consuming the
 * source files. Returns the text plus the envelopes scanned so the
 * caller can move them to `sent/` only after the outbound envelope is
 * durably on disk. Splitting scan from consume avoids losing late
 * replies when the outbound write throws: a move-then-write would
 * leave them stranded in `sent/` with no delivery. */
export function peekLateRepliesForPreamble() {
  const found = scanLateReplies();
  if (found.length === 0) return { preamble: "", found };
  const chunks = found.map(
    (r, i) =>
      `[Late reply ${i + 1}/${found.length} from Codex, originally sent ${r.createdAt || "earlier"}]\n${r.body}`
  );
  return { preamble: chunks.join("\n\n---\n\n"), found };
}

/** Move late-reply source files to `sent/`. Best-effort: a rename
 * failure does not roll back the dispatch. */
export function consumeLateReplyFiles(found) {
  for (const r of found) {
    try {
      renameSync(r.sourcePath, join(SENT_CLAUDE_DIR, r.filename));
    } catch {
      // best-effort
    }
  }
}

/** The reply envelope for a dispatched prompt id, matched on
 * `reply_to` / `chain_id` only. */
export function findReplyEnvelope(promptId) {
  for (const f of listInboxFiles()) {
    const parsed = readEnvelopeFile(join(INBOX_CLAUDE_DIR, f));
    if (!parsed) continue;
    if (
      parsed.fields.reply_to !== promptId &&
      parsed.fields.chain_id !== promptId
    ) {
      continue;
    }
    return { filename: f, body: parsed.body, fields: parsed.fields };
  }
  return null;
}

export function withPreamble(latePreamble, body) {
  return latePreamble ? `${latePreamble}\n\n---\n\n${body}` : body;
}

/** Move a delivered reply to `sent/` and return its body wrapped
 * with any late-reply preamble. */
export function consumeReplyAndFormat(replyMatch, latePreamble) {
  try {
    renameSync(
      join(INBOX_CLAUDE_DIR, replyMatch.filename),
      join(SENT_CLAUDE_DIR, replyMatch.filename)
    );
  } catch {
    // best-effort
  }
  return textResult(withPreamble(latePreamble, replyMatch.body));
}

/** MCP resource backing `bridge://inbox/codex`. Read-only peek with
 * no consumption side effect. The active dispatch path peeks via
 * `peekLateRepliesForPreamble` and consumes only after the outbound
 * envelope is durably on disk. */
export async function listInboxResource() {
  ensureMailboxDirs();
  const found = scanLateReplies();
  return {
    pending: found.map((r) => ({
      filename: r.filename,
      createdAt: r.createdAt,
      body: r.body,
    })),
    note:
      found.length > 0
        ? "Late replies are queued. Retrieve them with `wat321_bridge()` (drains the inbox and returns the bodies), or they auto-include as a preamble on the next Codex dispatch."
        : "Inbox is empty.",
  };
}
