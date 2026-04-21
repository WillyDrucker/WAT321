import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bridgeThreadNamePattern } from "./threadNaming";
import {
  loadBridgeThreadRecord,
  saveBridgeThreadRecord,
  type BridgeThreadRecord,
} from "./threadRecord";

/**
 * Read-only scans over Codex's session storage. Two surfaces:
 *   - `findRolloutPath` walks `~/.codex/sessions/` for the rollout
 *     file backing a given threadId. The TurnMonitor stats + tails
 *     this for stage advancement.
 *   - `listRecoverableSessions` walks Codex's `session_index.jsonl`
 *     for prior bridge threads whose rollout file still exists, so
 *     the user can reattach via the Recover menu.
 *
 * Codex never cleans its session_index even after a session delete -
 * stale entries are filtered by checking that the rollout file still
 * exists on disk. We never mutate Codex's state files.
 */

export interface RecoverableSession {
  threadId: string;
  sessionCounter: number;
  displayName: string;
  createdAt: string | null;
}

/** Walk ~/.codex/sessions/ recursively and return the absolute path
 * of the first file whose name contains the given threadId. Used by
 * the TurnMonitor to stat + tail the bridge-specific rollout (not
 * just "newest by mtime for this workspace" which may be a user TUI
 * session). Returns null if not found. Best-effort walk; filesystem
 * errors are silently swallowed. */
export function findRolloutPath(threadId: string): string | null {
  const root = join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) return null;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.name.includes(threadId)) {
        return p;
      }
    }
  }
  return null;
}

/** Walk ~/.codex/sessions/ recursively and return the mtime of the
 * first file whose name contains the given threadId. Used as a fallback
 * timestamp when the session_index.jsonl entry has no created_at field.
 * Returns null if the rollout file is not found. */
function findRolloutMtime(threadId: string): string | null {
  const path = findRolloutPath(threadId);
  if (path === null) return null;
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

/** List every Codex session in the local index whose thread_name
 * matches our bridge pattern for this workspace. Sorted by counter
 * descending (newest first). Read-only scan; we never mutate Codex
 * state here. Used by the Recover action to let the user reattach
 * the bridge to a previously-abandoned session. */
export function listRecoverableSessions(workspacePath: string): RecoverableSession[] {
  const pattern = bridgeThreadNamePattern(workspacePath);
  const indexPath = join(homedir(), ".codex", "session_index.jsonl");
  if (!existsSync(indexPath)) return [];

  const out: RecoverableSession[] = [];
  try {
    const raw = readFileSync(indexPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as {
          id?: string;
          thread_name?: string;
          created_at?: string;
        };
        const name = entry.thread_name ?? "";
        const m = pattern.exec(name);
        if (m === null) continue;
        const counter = parseInt(m[1], 10);
        if (!Number.isFinite(counter)) continue;
        if (entry.id === undefined) continue;
        // Codex does not clean its own index when a session is
        // deleted - the entry stays but the rollout file is gone.
        // Filter out entries whose rollout no longer exists so the
        // Recover dropdown only offers live sessions. We never edit
        // Codex's index; stale entries just don't surface in our UI.
        const mtime = findRolloutMtime(entry.id);
        if (mtime === null) continue;
        out.push({
          threadId: entry.id,
          sessionCounter: counter,
          displayName: name,
          createdAt: entry.created_at ?? mtime,
        });
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // read error - return whatever we accumulated
  }
  out.sort((a, b) => b.sessionCounter - a.sessionCounter);
  return out;
}

/** Attach the bridge record to an existing Codex thread: preserves
 * createdAt, resets failure fields, uses the recovered counter. If no
 * record existed yet, creates one. Atomic tmp+rename via save. */
export function recoverBridgeThread(
  workspacePath: string,
  session: RecoverableSession
): BridgeThreadRecord {
  const current = loadBridgeThreadRecord(workspacePath);
  const next: BridgeThreadRecord = {
    threadId: session.threadId,
    sessionCounter: session.sessionCounter,
    workspacePath,
    createdAt: current.createdAt,
    lastResetAt: current.lastResetAt,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    lastError: null,
  };
  saveBridgeThreadRecord(next);
  return next;
}
