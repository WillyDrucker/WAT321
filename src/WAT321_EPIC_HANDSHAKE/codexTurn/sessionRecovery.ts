import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import { basename, join } from "node:path";
import { readFirstLine } from "../../engine/fs/fileReaders";
import { samePath } from "../../engine/fs/pathIdentity";
import {
  CODEX_SESSION_INDEX_PATH,
  CODEX_SESSIONS_DIR,
} from "../../shared/providers/codex/codexHome";
import { readRolloutLatestModel } from "./rolloutModel";
import { bridgeThreadNamePattern } from "./threadNaming";
import {
  loadBridgeThreadRecord,
  saveBridgeThreadRecord,
  type BridgeThreadRecord,
} from "./threadRecord";

/**
 * Read-only scans over Codex's session storage, plus the one write
 * that reattaches the bridge record to a session they surface.
 *   - `walkRolloutFiles` and `findRolloutPath` walk `~/.codex/sessions/`
 *     for every rollout, and for the one backing a given threadId. The
 *     TurnMonitor stats + tails that one for stage advancement.
 *   - `readRolloutCwd` proves which workspace a rollout belongs to.
 *   - `listRecoverableSessions` walks Codex's `session_index.jsonl`
 *     for prior bridge threads whose rollout file still exists, so
 *     the user can reattach via the Recover menu.
 *
 * Codex never cleans its session_index even after a session delete -
 * stale entries are filtered by checking that the rollout file still
 * exists on disk. Nothing here mutates Codex's state files. Model slug
 * readers live in `rolloutModel.ts`.
 */

export interface RecoverableSession {
  threadId: string;
  sessionCounter: number;
  displayName: string;
  createdAt: string | null;
}

/** Every file under `~/.codex/sessions/`, depth-first. Best-effort:
 * a directory that cannot be read is skipped. */
export function* walkRolloutFiles(): Generator<string> {
  if (!existsSync(CODEX_SESSIONS_DIR)) return;
  const stack: string[] = [CODEX_SESSIONS_DIR];
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
      if (e.isDirectory()) stack.push(p);
      else yield p;
    }
  }
}

/** Absolute path of the first rollout whose file name contains the
 * given threadId, so the TurnMonitor stats + tails the bridge's own
 * rollout rather than "newest by mtime for this workspace", which may
 * be a user TUI session. Null when not found. */
export function findRolloutPath(threadId: string): string | null {
  for (const p of walkRolloutFiles()) {
    if (basename(p).includes(threadId)) return p;
  }
  return null;
}

/** Read `session_meta.payload.cwd` from the rollout header. Confirms a
 * rollout actually belongs to the current workspace before a recovery
 * or bulk-delete set claims it. Basename match on the thread name is
 * not enough on its own - two workspaces named `foo` in different
 * parent paths would collide. Null on any parse failure - callers treat
 * that as "do not claim ownership". */
export function readRolloutCwd(rolloutPath: string): string | null {
  // `readFirstLine` reads in chunks until a newline, so an oversized
  // session_meta first line (routinely 15-25KB on recent Codex CLI
  // rollouts - can grow further as Codex adds metadata) is always
  // captured intact. A fixed-size head read truncates mid-object for
  // any rollout whose session_meta exceeds the cap, which silently
  // rejects every affected session from bridge discovery.
  const firstLine = readFirstLine(rolloutPath);
  if (firstLine === null) return null;
  try {
    const entry = JSON.parse(firstLine) as {
      type?: string;
      payload?: { cwd?: unknown };
    };
    if (entry.type !== "session_meta") return null;
    const cwd = entry.payload?.cwd;
    return typeof cwd === "string" ? cwd : null;
  } catch {
    return null;
  }
}

/** List every Codex session in the local index whose thread_name
 * matches our bridge pattern for this workspace. Sorted by counter
 * descending (newest first). Read-only scan - we never mutate Codex
 * state here. Used by the Recover action to let the user reattach
 * the bridge to a previously-abandoned session. */
export function listRecoverableSessions(workspacePath: string): RecoverableSession[] {
  const pattern = bridgeThreadNamePattern(workspacePath);
  if (!existsSync(CODEX_SESSION_INDEX_PATH)) return [];

  const out: RecoverableSession[] = [];
  try {
    const raw = readFileSync(CODEX_SESSION_INDEX_PATH, "utf8");
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
        // Recover dropdown only offers live sessions.
        const rolloutPath = findRolloutPath(entry.id);
        if (rolloutPath === null) continue;
        // Basename-scoped thread-name match is ambiguous when two
        // workspaces share a basename in different parent paths, so
        // require the rollout header's cwd to match this workspace.
        // Sessions whose header cannot be read or fails the match are
        // skipped - only sessions provably ours are claimed.
        const rolloutCwd = readRolloutCwd(rolloutPath);
        if (rolloutCwd === null || !samePath(rolloutCwd, workspacePath)) {
          continue;
        }
        let mtime: string | null = null;
        try {
          mtime = new Date(statSync(rolloutPath).mtimeMs).toISOString();
        } catch {
          // fall through - createdAt from index is acceptable fallback
        }
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

/** The model a recoverable session was last running, or null when its
 * rollout cannot be located or read. */
function recoveredModelSlug(threadId: string): string | null {
  const rolloutPath = findRolloutPath(threadId);
  return rolloutPath === null ? null : readRolloutLatestModel(rolloutPath);
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
    // Adopt the RECOVERED session's model, not the one the record
    // happened to be carrying for the session we just walked away from.
    // Null effort lets `readSessionPin` derive that model's own default
    // on the next read rather than applying a level the model may not
    // advertise.
    model: recoveredModelSlug(session.threadId),
    effort: null,
    // A recovered session is a different thread, so it starts at
    // standard speed like any session the user did not tune.
    serviceTier: null,
    // Decided here, from the recovered session's own rollout. Leaving it
    // unresolved would send `readSessionPin` back through legacy-flag
    // migration, where a surviving flag outranks the rollout and could
    // pin the recovered thread to a model it never ran.
    pinResolved: true,
  };
  saveBridgeThreadRecord(next);
  return next;
}
