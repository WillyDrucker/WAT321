import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { EPIC_HANDSHAKE_DIR } from "./constants";
import { workspaceHash } from "./workspaceHash";

/**
 * Per-workspace persistence for the shared Codex bridge thread. One
 * record per workspace, keyed by `workspaceHash(path)`. Stores the
 * current Codex `thread_id`, a session counter (increments on reset),
 * and a friendly display name derived from the workspace folder.
 *
 * Reset command nulls `thread_id` and bumps `sessionCounter`; next
 * prompt spawns a fresh thread with the incremented S<N> in the name.
 *
 * Atomic tmp+rename on every write - a crash mid-write cannot corrupt
 * the stored state.
 */

export interface BridgeThreadRecord {
  /** Current Codex thread id, or null if no thread started yet or
   * reset. When null, next prompt creates a fresh thread. */
  threadId: string | null;
  /** 1-indexed counter appended to thread name as `S<N>`. Incremented
   * on every reset; helps users see which session is current in the
   * Codex TUI picker and avoids name collisions on rapid resets. */
  sessionCounter: number;
  /** Absolute workspace path this record belongs to. Redundant with
   * the filename hash, but stored for debugging and integrity check. */
  workspacePath: string;
  /** ISO timestamp of first creation. */
  createdAt: string;
  /** ISO timestamp of last reset, or null if never reset. */
  lastResetAt: string | null;
  /** ISO timestamp of last successful prompt, or null. Used to
   * short-circuit the resume round-trip if the last prompt was
   * recent enough that the thread is certainly still good. */
  lastSuccessAt?: string | null;
  /** Consecutive recoverable-shaped failures since last success.
   * Threshold-based rotation (default 3) kicks in if this stays
   * elevated - protects against threads stuck in a bad state. */
  consecutiveFailures?: number;
  /** Short description of the most recent failure for diagnostics
   * and health-command display. */
  lastError?: string | null;
}

function recordPath(workspacePath: string): string {
  return join(EPIC_HANDSHAKE_DIR, `bridge-thread.${workspaceHash(workspacePath)}.json`);
}

/** Load the record for a workspace, or return null if none exists.
 * Used by callers that need to distinguish "no record yet" from
 * "record with default values." Never throws. */
export function loadBridgeThreadRecordIfExists(
  workspacePath: string
): BridgeThreadRecord | null {
  const path = recordPath(workspacePath);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<BridgeThreadRecord>;
    return {
      threadId: parsed.threadId ?? null,
      sessionCounter: parsed.sessionCounter ?? 1,
      workspacePath: parsed.workspacePath ?? workspacePath,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      lastResetAt: parsed.lastResetAt ?? null,
      lastSuccessAt: parsed.lastSuccessAt ?? null,
      consecutiveFailures: parsed.consecutiveFailures ?? 0,
      lastError: parsed.lastError ?? null,
    };
  } catch {
    return null;
  }
}

/** Load the record for a workspace, or return a fresh default if
 * none exists yet. Never throws on missing file. */
export function loadBridgeThreadRecord(workspacePath: string): BridgeThreadRecord {
  const path = recordPath(workspacePath);
  if (!existsSync(path)) {
    return {
      threadId: null,
      sessionCounter: 1,
      workspacePath,
      createdAt: new Date().toISOString(),
      lastResetAt: null,
    };
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<BridgeThreadRecord>;
    return {
      threadId: parsed.threadId ?? null,
      sessionCounter: parsed.sessionCounter ?? 1,
      workspacePath: parsed.workspacePath ?? workspacePath,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      lastResetAt: parsed.lastResetAt ?? null,
      lastSuccessAt: parsed.lastSuccessAt ?? null,
      consecutiveFailures: parsed.consecutiveFailures ?? 0,
      lastError: parsed.lastError ?? null,
    };
  } catch {
    return {
      threadId: null,
      sessionCounter: 1,
      workspacePath,
      createdAt: new Date().toISOString(),
      lastResetAt: null,
    };
  }
}

/** Atomic tmp+rename. Caller handles errors via try/catch if needed. */
export function saveBridgeThreadRecord(record: BridgeThreadRecord): void {
  const path = recordPath(record.workspacePath);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
  renameSync(tmp, path);
}

/** Clear the error counter and last-error message without touching
 * the threadId or counter. Lets the user acknowledge a transient
 * failure (timeout, network blip) and return the widget to the
 * idle state without rotating the Codex session. */
export function clearBridgeErrorState(workspacePath: string): BridgeThreadRecord {
  const current = loadBridgeThreadRecord(workspacePath);
  const next: BridgeThreadRecord = {
    ...current,
    consecutiveFailures: 0,
    lastError: null,
  };
  saveBridgeThreadRecord(next);
  return next;
}

/** Reset: null the thread id, bump counter, stamp reset time. The
 * stored record is kept so the counter carries forward. Next prompt
 * creates a fresh Codex thread with S<N+1>. */
export function resetBridgeThread(workspacePath: string): BridgeThreadRecord {
  const current = loadBridgeThreadRecord(workspacePath);
  const next: BridgeThreadRecord = {
    ...current,
    threadId: null,
    sessionCounter: current.sessionCounter + 1,
    lastResetAt: new Date().toISOString(),
  };
  saveBridgeThreadRecord(next);
  return next;
}

/** Build the Codex thread display name. Shown in the Codex TUI's
 * session picker so the user can inspect what the bridge is doing.
 * Format: "<Project> Epic Handshake Claude-to-Codex S<N>" */
export function bridgeThreadDisplayName(
  workspacePath: string,
  sessionCounter: number
): string {
  const project = basename(workspacePath) || "Workspace";
  return `${project} Epic Handshake Claude-to-Codex S${sessionCounter}`;
}

/** Scan Codex's `~/.codex/session_index.jsonl` for any existing
 * threads whose `thread_name` matches our bridge naming pattern
 * for this workspace. Returns the max `S<N>` seen, or 0 if none.
 *
 * Used to pick a collision-free counter even when the user has
 * deleted sessions externally (which doesn't touch our state) or
 * manually renamed things. Read-only - we never modify Codex's
 * own state files. */
export function maxExistingSessionCounter(workspacePath: string): number {
  const project = basename(workspacePath) || "Workspace";
  const escaped = project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^${escaped} Epic Handshake Claude-to-Codex S(\\d+)$`
  );

  const indexPath = join(homedir(), ".codex", "session_index.jsonl");
  if (!existsSync(indexPath)) return 0;

  let maxSeen = 0;
  try {
    const raw = readFileSync(indexPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { thread_name?: string };
        const m = pattern.exec(entry.thread_name ?? "");
        if (m !== null) {
          const n = parseInt(m[1], 10);
          if (Number.isFinite(n) && n > maxSeen) maxSeen = n;
        }
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // read error - fall through with maxSeen=0
  }
  return maxSeen;
}

/** Pick the next collision-free session counter for this workspace.
 * Returns max(our current counter, maxExistingSessionCounter + 1).
 * Guarantees no name collision in the Codex TUI even if the user
 * has deleted sessions externally without using our Reset command. */
export function nextCollisionFreeCounter(
  workspacePath: string,
  currentCounter: number
): number {
  const maxSeen = maxExistingSessionCounter(workspacePath);
  return Math.max(currentCounter, maxSeen + 1);
}

export interface RecoverableSession {
  threadId: string;
  sessionCounter: number;
  displayName: string;
  createdAt: string | null;
}

/** Walk ~/.codex/sessions/ recursively and return the mtime of the
 * first file whose name contains the given threadId. Used as a fallback
 * timestamp when the session_index.jsonl entry has no created_at field.
 * Returns null if the rollout file is not found. */
function findRolloutMtime(threadId: string): string | null {
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
        try {
          return new Date(statSync(p).mtimeMs).toISOString();
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** List every Codex session in the local index whose thread_name
 * matches our bridge pattern for this workspace. Sorted by counter
 * descending (newest first). Read-only scan; we never mutate Codex
 * state here. Used by the Recover action to let the user reattach
 * the bridge to a previously-abandoned session. */
export function listRecoverableSessions(workspacePath: string): RecoverableSession[] {
  const project = basename(workspacePath) || "Workspace";
  const escaped = project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^${escaped} Epic Handshake Claude-to-Codex S(\\d+)$`
  );

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
