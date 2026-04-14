import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Epic Handshake shared constants. All paths live here so the rest of
 * the module can import exactly the pieces it needs without
 * duplication. Timing and protocol constants will be added alongside
 * the JSON-RPC client in Phase 3.
 */

/** Root of all Epic Handshake on-disk state. Lives inside the standard
 * `~/.wat321/` data directory so it gets wiped by Reset WAT321. */
export const EPIC_HANDSHAKE_DIR = join(
  homedir(),
  ".wat321",
  "epic-handshake"
);

/** Inbox directories. Files land here when a message is addressed to
 * the named agent. Watched by the Codex-side file watcher; read by
 * the Claude-side `UserPromptSubmit` hook. */
export const INBOX_CLAUDE_DIR = join(EPIC_HANDSHAKE_DIR, "inbox", "claude");
export const INBOX_CODEX_DIR = join(EPIC_HANDSHAKE_DIR, "inbox", "codex");

/** Sent archive directories. Files move here after successful
 * delivery so they never re-deliver. */
export const SENT_CLAUDE_DIR = join(EPIC_HANDSHAKE_DIR, "sent", "claude");
export const SENT_CODEX_DIR = join(EPIC_HANDSHAKE_DIR, "sent", "codex");

/** Persisted Codex Bridge thread id record. Written atomically after
 * every successful `thread/start` or `thread/resume` so the next VS
 * Code window can reload the same headless consultation thread. */
export const CODEX_THREAD_PATH = join(EPIC_HANDSHAKE_DIR, "codex-thread.json");

/** Consent stamp. Presence marks the user as having accepted the
 * first-run Epic Handshake consent toast. */
export const CONSENT_STAMP_PATH = join(
  EPIC_HANDSHAKE_DIR,
  "consent-granted.json"
);

/** Per-instance runtime state file. Instance ids are generated fresh
 * on each VS Code window activation and used in logs plus state-file
 * names so multiple windows' debug output can be told apart. */
export function instanceStatePath(instanceId: string): string {
  return join(EPIC_HANDSHAKE_DIR, `instance-${instanceId}.json`);
}
