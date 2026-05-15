import { existsSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  EPIC_HANDSHAKE_DIR,
  inboxClaudeDir,
  inboxCodexDir,
  sentClaudeDir,
  sentCodexDir,
} from "./constants";

/**
 * Workspace-scoped wipe of every Epic Handshake artifact tied to a
 * specific wsHash. Used by `resetCleanup` to clear THIS workspace's
 * EH state without disturbing peer windows.
 *
 * Targets:
 *   - inbox/codex/<wsHash>/ + inbox/claude/<wsHash>/ (envelopes)
 *   - sent/codex/<wsHash>/ + sent/claude/<wsHash>/ (history)
 *   - every `*.<wsHash>.flag` file at the EH root (runtime sentinels
 *     plus user-data flags - reset is the moment to clear both)
 *
 * Skips peer wsHash subfolders and root-level shared content (the
 * bin/ subdir, turn-heartbeat.*.json which self-cleans, the pre-
 * partition legacy sentinels which `clearStaleRuntimeFiles` handles
 * on the next activate).
 */
export function wipeWorkspaceEpicHandshakeState(wsHash: string): void {
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
}
