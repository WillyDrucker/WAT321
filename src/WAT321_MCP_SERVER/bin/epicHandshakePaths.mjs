import { join } from "node:path";
import { EPIC_HANDSHAKE_DIR, workspaceId } from "./wat321Paths.mjs";

/**
 * Epic Handshake mailbox and flag paths for THIS workspace. MJS
 * counterpart to `src/WAT321_EPIC_HANDSHAKE/epicHandshakePaths.ts`,
 * which the extension host uses for the same files. Everything is
 * keyed off `WAT321_WORKSPACE_ID` (the wsHash the installer injects)
 * for both sentinel filenames and inbox/sent partition dirs. Deriving
 * the hash from cwd here would diverge from what the extension
 * watches whenever Claude Code spawns the MCP process from a
 * different cwd than the active VS Code workspace folder.
 */

export const WORKSPACE_HASH = workspaceId();
/** Envelope metadata only. Not used for routing: the partition dir
 * derived from WORKSPACE_HASH is what consumers read. */
export const WORKSPACE_PATH = process.env.WAT321_WORKSPACE_PATH || process.cwd();

export const INBOX_CLAUDE_DIR = join(EPIC_HANDSHAKE_DIR, "inbox", "claude", WORKSPACE_HASH);
export const INBOX_CODEX_DIR = join(EPIC_HANDSHAKE_DIR, "inbox", "codex", WORKSPACE_HASH);
export const SENT_CLAUDE_DIR = join(EPIC_HANDSHAKE_DIR, "sent", "claude", WORKSPACE_HASH);

export const PAUSED_FLAG_PATH = join(EPIC_HANDSHAKE_DIR, `paused.${WORKSPACE_HASH}.flag`);
export const FIRE_AND_FORGET_FLAG_PATH = join(
  EPIC_HANDSHAKE_DIR,
  `fire-and-forget.${WORKSPACE_HASH}.flag`
);
export const ADAPTIVE_FLAG_PATH = join(EPIC_HANDSHAKE_DIR, `adaptive.${WORKSPACE_HASH}.flag`);
/** Written at the start of a sync / adaptive wait and cleared in
 * finally. Its fresh presence is the in-flight signal the dispatch
 * guard reads, and `WAT321_EPIC_HANDSHAKE/codexTurn/waitStatus.ts` renders it as
 * "Waiting on Codex: Ns" in the Claude session-token tooltip. */
export const WAIT_STATUS_PATH = join(
  EPIC_HANDSHAKE_DIR,
  `wait-status.${WORKSPACE_HASH}.json`
);

export function turnHeartbeatPath(dispatchId) {
  return join(EPIC_HANDSHAKE_DIR, `turn-heartbeat.${dispatchId}.json`);
}

export function returningFlagPath(wsHash) {
  return join(EPIC_HANDSHAKE_DIR, `returning.${wsHash}.flag`);
}
