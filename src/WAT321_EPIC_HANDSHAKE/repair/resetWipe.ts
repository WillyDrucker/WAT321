import { existsSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { workspaceHash } from "../../engine/workspaceHash";
import {
  EPIC_HANDSHAKE_DIR,
  inboxClaudeDir,
  inboxCodexDir,
  sentClaudeDir,
  sentCodexDir,
} from "../epicHandshakePaths";
import {
  loadBridgeThreadRecordIfExists,
  saveBridgeThreadRecord,
} from "../codexTurn/threadRecord";

/**
 * Workspace-scoped wipe of every Epic Handshake artifact tied to one
 * workspace. Used by `resetCleanup` to clear THIS workspace's EH state
 * without disturbing peer windows.
 *
 * Targets:
 *   - inbox/codex/<wsHash>/ + inbox/claude/<wsHash>/ (envelopes)
 *   - sent/codex/<wsHash>/ + sent/claude/<wsHash>/ (history)
 *   - every `*.<wsHash>.flag` file at the EH root (runtime sentinels
 *     plus user-data flags - reset is the moment to clear both)
 *   - the session's pinned model + effort, cleared in place
 *
 * The session record itself SURVIVES, because its `sessionCounter` is
 * what keeps S<N> names from colliding with rollouts still on disk.
 * Only the pin is cleared, so Reset returns the user to Codex's current
 * recommendation exactly as it did when the pin lived in a `.flag` file
 * that this sweep deleted.
 *
 * Skips peer wsHash subfolders and root-level shared content (the
 * bin/ subdir, turn-heartbeat.*.json which self-cleans, the pre-
 * partition legacy sentinels which `clearStaleRuntimeFiles` handles
 * on the next activate).
 */
export function wipeWorkspaceEpicHandshakeState(workspacePath: string): void {
  const wsHash = workspaceHash(workspacePath);
  for (const dir of [
    inboxCodexDir(wsHash),
    inboxClaudeDir(wsHash),
    sentCodexDir(wsHash),
    sentClaudeDir(wsHash),
  ]) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  if (!existsSync(EPIC_HANDSHAKE_DIR)) return;
  let entries: string[];
  try {
    entries = readdirSync(EPIC_HANDSHAKE_DIR);
  } catch {
    return;
  }
  const suffix = `.${wsHash}.flag`;
  for (const name of entries) {
    if (!name.endsWith(suffix)) continue;
    try {
      unlinkSync(join(EPIC_HANDSHAKE_DIR, name));
    } catch {
      // best-effort
    }
  }

  try {
    const record = loadBridgeThreadRecordIfExists(workspacePath);
    if (record !== null) {
      // `pinResolved` is what stops `readSessionPin` from walking the
      // still-live thread's rollout and restoring the model we just
      // cleared. Reset keeps the thread alive, so the marker is the only
      // signal that a null pin means "Codex's recommendation" rather than
      // "go recover what this thread was running".
      saveBridgeThreadRecord({
        ...record,
        model: null,
        effort: null,
        pinResolved: true,
      });
    }
  } catch {
    // best-effort
  }
}
