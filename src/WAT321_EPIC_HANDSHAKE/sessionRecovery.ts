import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { readFirstLine, readHead, readTail } from "../shared/fs/fileReaders";
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
 * session). Returns null if not found. Best-effort walk - filesystem
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

/** Read `session_meta.payload.cwd` from the rollout header. Used to
 * confirm a rollout actually belongs to the current workspace before
 * including it in a recoverable or bulk-delete set. Basename match on
 * the thread name is not enough on its own - two workspaces named `foo`
 * in different parent paths would collide. Returns null on any parse
 * failure - callers treat that as "do not claim ownership". */
function readRolloutCwd(rolloutPath: string): string | null {
  // `readFirstLine` reads in chunks until a newline, so an oversized
  // session_meta first line (routinely 15-25KB on recent Codex CLI
  // rollouts - can grow further as Codex adds metadata) is always
  // captured intact. Previous `readHead` at 8KB default truncated
  // mid-object for any rollout whose session_meta exceeded the cap,
  // silently rejecting every affected session from bridge discovery.
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

/** Read `session_meta.payload.model` from the rollout header. Locked
 * at session creation - every `thread/resume` ships this value to the
 * API. A slug that's no longer in the user's Codex `models_cache.json`
 * (because the CLI upgraded and renamed or retired that model) 404s
 * on the next resume. The dispatcher uses this to gate broken sessions
 * at pre-flight instead of letting them fail mid-turn. */
export function readRolloutModelSlug(rolloutPath: string): string | null {
  const firstLine = readFirstLine(rolloutPath);
  if (firstLine === null) return null;
  try {
    const entry = JSON.parse(firstLine) as {
      type?: string;
      payload?: { model?: unknown };
    };
    if (entry.type !== "session_meta") return null;
    const model = entry.payload?.model;
    return typeof model === "string" ? model : null;
  } catch {
    return null;
  }
}

/** How many leading rollout lines `readRolloutEffectiveModel` will scan
 * for a `turn_context`. The event is emitted at the head of the first
 * turn, so it lands within the first few lines or not at all. */
const TURN_CONTEXT_SCAN_LINES = 12;

/** The model a rollout's session ACTUALLY ran, not just what its header
 * declares.
 *
 * `session_meta.payload.model` is absent on rollouts written by older
 * Codex CLIs, which recorded the model only on the `turn_context` event
 * at the head of the first turn. `readRolloutModelSlug` returns null for
 * those, which is the right answer for its own callers (they gate on the
 * value `thread/resume` ships) but the wrong answer when the question is
 * "what has this session been running".
 *
 * Used by the session-pin migration, where a null would mean adopting
 * Codex's current default and silently moving a long-lived session onto
 * a new model. Falls back to the header, then to the first
 * `turn_context.model`, then to null. */
export function readRolloutEffectiveModel(rolloutPath: string): string | null {
  const fromHeader = readRolloutModelSlug(rolloutPath);
  if (fromHeader !== null) return fromHeader;

  // Generous cap: `session_meta` alone routinely runs 15-25KB and keeps
  // growing as Codex adds metadata, and `turn_context` follows it. A cap
  // that truncated the header would leave line 0 unparseable and abort
  // the scan before reaching the line we came for.
  const raw = readHead(rolloutPath, 262_144);
  if (raw === null) return null;
  const lines = raw.split("\n");
  for (const line of lines.slice(0, TURN_CONTEXT_SCAN_LINES)) {
    if (line.length === 0) continue;
    let entry: { type?: string; payload?: { model?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      // A truncated final line is expected when the head cap splits an
      // event. Stop rather than keep scanning garbage.
      break;
    }
    if (entry.type !== "turn_context") continue;
    const model = entry.payload?.model;
    if (typeof model === "string" && model.length > 0) return model;
  }
  return null;
}

/** Rewrite `session_meta.payload.model` on a bridge-owned rollout to a
 * valid slug. Only the first line gets modified - every subsequent
 * turn event passes through byte-for-byte. Writes to a tmp file and
 * atomic-renames so a partial write cannot leave the rollout truncated.
 *
 * Caller owns the ownership gate (thread_name match + cwd match). This
 * helper just performs the edit - it does NOT verify the rollout is
 * bridge-owned, so never call with a rollout path you haven't already
 * gated. Returns true on successful rewrite, false on any failure
 * (unreadable, unparseable first line, write error, rename EBUSY on
 * Windows when Codex has the file open mid-turn). */
export function rewriteRolloutModelSlug(
  rolloutPath: string,
  newSlug: string
): boolean {
  let raw: string;
  try {
    raw = readFileSync(rolloutPath, "utf8");
  } catch {
    return false;
  }
  const newlineIdx = raw.indexOf("\n");
  if (newlineIdx < 0) return false;
  const firstLine = raw.slice(0, newlineIdx);
  const remainder = raw.slice(newlineIdx);
  let entry: {
    type?: string;
    payload?: Record<string, unknown>;
    [k: string]: unknown;
  };
  try {
    entry = JSON.parse(firstLine);
  } catch {
    return false;
  }
  if (entry.type !== "session_meta" || !entry.payload) return false;
  entry.payload = { ...entry.payload, model: newSlug };
  let rewrittenFirstLine: string;
  try {
    rewrittenFirstLine = JSON.stringify(entry);
  } catch {
    return false;
  }
  // Windows may reject rename-over-open-file with EBUSY if Codex's
  // app-server has the rollout open. Caller's job to advise the user
  // to ensure no turn is mid-flight before retrying.
  return writeFileAtomic(rolloutPath, rewrittenFirstLine + remainder);
}

/** Compare two filesystem paths for workspace-identity purposes.
 * Normalizes Windows backslashes to forward slashes and strips a
 * trailing separator so `C:/Code/project` and `C:\Code\project\` match.
 * Case-insensitive on win32 because `C:\dev\...` and `C:\Dev\...`
 * name the same folder. */
function pathsMatch(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

/** List every Codex session in the local index whose thread_name
 * matches our bridge pattern for this workspace. Sorted by counter
 * descending (newest first). Read-only scan - we never mutate Codex
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
        // Codex's index - stale entries just don't surface in our UI.
        const rolloutPath = findRolloutPath(entry.id);
        if (rolloutPath === null) continue;
        // Basename-scoped thread-name match is ambiguous when two
        // workspaces share a basename in different parent paths.
        // Confirm ownership by reading `session_meta.cwd` from the
        // rollout header and requiring an exact path match. Without
        // this a sibling `foo/` in another location can surface here
        // and get swept by bulk delete. Sessions whose header cannot
        // be read or fails the match are silently skipped - we only
        // claim sessions we can prove belong to this workspace.
        const rolloutCwd = readRolloutCwd(rolloutPath);
        if (rolloutCwd === null || !pathsMatch(rolloutCwd, workspacePath)) {
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

/** Attach the bridge record to an existing Codex thread: preserves
 * createdAt, resets failure fields, uses the recovered counter. If no
 * record existed yet, creates one. Atomic tmp+rename via save. */
/** Tail windows tried in order when hunting for the newest
 * `turn_context`, stopping at the first that finds one.
 *
 * `turn_context` is emitted at the START of a turn, so the tail of a
 * rollout is the middle of that turn's output, not its header. A single
 * long turn on a real 4.7MB rollout buried the last `turn_context` more
 * than 256KB from the end, and a 26MB rollout buried it further. The
 * windows escalate rather than starting large because the common case
 * (a short final turn) is answered by the first, and only a genuinely
 * long final turn pays for the bigger reads.
 *
 * The last entry is deliberately larger than any rollout observed. A
 * recovery is a rare, explicit user action, so reading the file once is
 * an acceptable price for getting the model right. */
const LATEST_MODEL_TAIL_WINDOWS = [262_144, 4_194_304, 33_554_432] as const;

/** The model a session was running MOST RECENTLY, by scanning backward
 * from the end of its rollout for the newest `turn_context.model`.
 *
 * Distinct from `readRolloutEffectiveModel`, which answers "what was
 * this session created with" by reading forward from the header. Both
 * questions are legitimate and they differ for any session whose model
 * changed mid-life:
 *   - `thread/resume` ships `session_meta.model`, so the header is the
 *     right answer for resume validation and rollout repair.
 *   - Recovering a session into the bridge should adopt what it was LAST
 *     running, because that is the state the user is returning to.
 *
 * Deliberately used only by `recoverBridgeThread`. Falls back to the
 * creation model when the tail carries no parseable `turn_context`,
 * which is the case for a session that never completed a turn.
 *
 * The first line of the tail window is almost always truncated mid-JSON.
 * That is expected and simply fails to parse, so it is skipped rather
 * than treated as the end of useful data. */
function readRolloutLatestModel(rolloutPath: string): string | null {
  let previousLength = -1;
  for (const window of LATEST_MODEL_TAIL_WINDOWS) {
    const raw = readTail(rolloutPath, window);
    if (raw === null) break;
    // A window that read no more than the last one means we already have
    // the whole file. Rescanning it at a larger size finds nothing new.
    if (raw.length <= previousLength) break;
    previousLength = raw.length;

    const found = lastTurnContextModel(raw);
    if (found !== null) return found;
  }
  return readRolloutEffectiveModel(rolloutPath);
}

/** Newest `turn_context.model` in a chunk of rollout lines, scanning
 * backward. Null when the chunk holds none.
 *
 * The first line of a tail window is almost always truncated mid-JSON.
 * It simply fails to parse and is skipped, which is why an unparseable
 * line continues the scan rather than ending it. */
function lastTurnContextModel(raw: string): string | null {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.length === 0) continue;
    let entry: { type?: string; payload?: { model?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== "turn_context") continue;
    const model = entry.payload?.model;
    if (typeof model === "string" && model.length > 0) return model;
  }
  return null;
}

/** The model a recoverable session was last running, or null when its
 * rollout cannot be located or read. */
function recoveredModelSlug(threadId: string): string | null {
  const rolloutPath = findRolloutPath(threadId);
  return rolloutPath === null ? null : readRolloutLatestModel(rolloutPath);
}

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
    // Decided here, from the recovered session's own rollout. Leaving it
    // unresolved would send `readSessionPin` back through legacy-flag
    // migration, where a surviving flag outranks the rollout and could
    // pin the recovered thread to a model it never ran.
    pinResolved: true,
  };
  saveBridgeThreadRecord(next);
  return next;
}
