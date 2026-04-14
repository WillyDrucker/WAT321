import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  EPIC_HANDSHAKE_DIR,
  INBOX_CLAUDE_DIR,
  INBOX_CODEX_DIR,
  SENT_CLAUDE_DIR,
  SENT_CODEX_DIR,
} from "./constants";
import { parseEnvelope, serializeEnvelope } from "./messageFormat";
import type { MessageEnvelope } from "./types";

/**
 * Bridge file I/O. All writes are atomic tmp+rename so a crash
 * mid-write cannot leave a partial file for a downstream reader.
 * Directory creates are best-effort: every write helper calls
 * `ensureDirectoryTree()` so first-time usage on a clean machine
 * just works.
 */

/** Create the standard Epic Handshake directory tree under
 * `~/.wat321/epic-handshake/`. Idempotent and best-effort. */
export function ensureDirectoryTree(): void {
  for (const dir of [
    EPIC_HANDSHAKE_DIR,
    INBOX_CLAUDE_DIR,
    INBOX_CODEX_DIR,
    SENT_CLAUDE_DIR,
    SENT_CODEX_DIR,
  ]) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch {
      // best-effort
    }
  }
}

/** Generate a new message id of the form
 * `YYYY-MM-DDTHH-MM-SS-<6hex>`. The hex suffix is random (3 bytes
 * = 6 chars) so two messages created in the same second collide
 * only with odds of roughly 1 in 16 million. */
export function generateMessageId(): string {
  const now = new Date();
  const pad = (n: number): string => n.toString().padStart(2, "0");
  const stamp =
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-` +
    `${pad(now.getUTCDate())}T${pad(now.getUTCHours())}-` +
    `${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}`;
  const suffix = randomBytes(3).toString("hex");
  return `${stamp}-${suffix}`;
}

/** Current UTC wall-clock time as an ISO 8601 string. Convenience
 * wrapper around `Date.toISOString()` so callers don't each need to
 * import the Date constructor for this single purpose. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Write a message envelope to the given directory atomically.
 * Returns the final absolute path of the written file. Filename is
 * always `<envelope.id>.md`. The `.tmp` intermediate is written
 * first, then renamed — so a reader that sees `<id>.md` is
 * guaranteed to see a complete, parseable file. */
export function writeMessage(
  dir: string,
  envelope: MessageEnvelope
): string {
  ensureDirectoryTree();
  const finalPath = join(dir, `${envelope.id}.md`);
  const tmpPath = `${finalPath}.tmp`;
  const text = serializeEnvelope(envelope);
  writeFileSync(tmpPath, text, "utf8");
  renameSync(tmpPath, finalPath);
  return finalPath;
}

/** Read a message envelope from an absolute file path. Throws
 * `MessageFormatError` on malformed frontmatter or unknown/unparseable
 * fields. */
export function readMessage(path: string): MessageEnvelope {
  const text = readFileSync(path, "utf8");
  return parseEnvelope(text);
}

/** List every `.md` message file in a directory, sorted by filename
 * (which sorts chronologically because the id starts with a
 * UTC-normalized ISO timestamp). A missing directory returns an empty
 * list rather than throwing — callers treat "no inbox" and "empty
 * inbox" identically. */
export function listInbox(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Move a delivered message from its current inbox location to the
 * corresponding `sent/` directory. Preserves the filename so the
 * original id is recoverable. Destination is derived from the parent
 * directory of the input path: messages in `inbox/claude/` move to
 * `sent/claude/`, same for codex. */
export function moveToSent(inboxPath: string): string {
  ensureDirectoryTree();
  const parent = dirname(inboxPath);
  let destDir: string;
  if (parent === INBOX_CLAUDE_DIR) {
    destDir = SENT_CLAUDE_DIR;
  } else if (parent === INBOX_CODEX_DIR) {
    destDir = SENT_CODEX_DIR;
  } else {
    throw new Error(
      `moveToSent: path is not in a known inbox directory: ${inboxPath}`
    );
  }
  const destPath = join(destDir, basename(inboxPath));
  renameSync(inboxPath, destPath);
  return destPath;
}
