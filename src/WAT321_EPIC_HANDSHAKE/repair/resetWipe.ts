import { existsSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { workspaceHash } from "../../engine/workspaceHash";
import { EPIC_HANDSHAKE_DIR } from "../../engine/wat321Paths";
import {
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
 * workspace, used by `resetCleanup` so peer windows are untouched:
 * inbox and sent envelopes under the workspace hash, every
 * `*.<wsHash>.flag` at the EH root (runtime sentinels and user-data
 * flags alike), and the session's pinned model and effort, cleared
 * in place. The session record itself SURVIVES because its
 * `sessionCounter` keeps S<N> names from colliding with rollouts still
 * on disk, and clearing only the pin returns the user to Codex's
 * current recommendation. Peer wsHash folders and root-level shared
 * content are skipped: `bin/`, the self-cleaning
 * `turn-heartbeat.*.json`, and the pre-partition legacy sentinels that
 * `clearStaleRuntimeFiles` handles on the next activate.
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
        serviceTier: null,
        pinResolved: true,
      });
    }
  } catch {
    // best-effort
  }
}
