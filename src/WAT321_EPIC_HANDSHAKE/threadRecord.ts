import {
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { EPIC_HANDSHAKE_DIR } from "./constants";
import { workspaceHash } from "../shared/workspaceHash";

/**
 * Per-workspace persistence for the shared Codex bridge thread. One
 * record per workspace, keyed by `workspaceHash(path)`. Stores the
 * current Codex `thread_id`, a session counter (increments on reset),
 * and a friendly display name derived from the workspace folder.
 *
 * Reset command nulls `thread_id` and bumps `sessionCounter` - next
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
   * on every reset - helps users see which session is current in the
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
  /** Model this session runs, pinned for the session's whole life.
   *
   * Set once when the thread is born, from whatever Codex recommends
   * at that moment (`model/list`'s `isDefault`). Changed only when the
   * user picks a different model in the Codex Model Settings picker.
   * Survives window close, machine reboot, and app-server restart,
   * because Codex itself does NOT remember a thread's model: a cold
   * `thread/resume` returns the `config.toml` model, not the one the
   * thread last ran (verified via probe). We are the memory.
   *
   * Null on records written before this field existed, and on a record
   * whose session was reset. Both mean "materialize Codex's current
   * recommendation on next spawn." */
  model?: string | null;
  /** Reasoning effort for this session. Same lifetime and same null
   * semantics as `model`. Kept beside it so a session is described by
   * exactly one file, and deleting the session forgets both. */
  effort?: string | null;
  /** True once this record's pin has been DECIDED, whether decided onto
   * a model or deliberately cleared.
   *
   * Without this, `model === null` is overloaded: it means both "this
   * record predates the field, go recover what the thread was running"
   * and "the user just reset, give them Codex's recommendation". Reset
   * leaves the thread alive, so the first reading would send migration
   * back to the old rollout and restore the very model reset had
   * cleared. The flag disambiguates: null + resolved means "Codex's
   * recommendation", null + unresolved means "migrate". */
  pinResolved?: boolean;
}

export function recordPath(workspacePath: string): string {
  return join(EPIC_HANDSHAKE_DIR, `bridge-thread.${workspaceHash(workspacePath)}.json`);
}

/** Fill a parsed record's every field. Both loaders route through
 * here so a field added to `BridgeThreadRecord` cannot be hydrated in
 * one and silently dropped in the other. */
function hydrate(
  parsed: Partial<BridgeThreadRecord>,
  workspacePath: string
): BridgeThreadRecord {
  return {
    threadId: parsed.threadId ?? null,
    sessionCounter: parsed.sessionCounter ?? 1,
    workspacePath: parsed.workspacePath ?? workspacePath,
    createdAt: parsed.createdAt ?? new Date().toISOString(),
    lastResetAt: parsed.lastResetAt ?? null,
    lastSuccessAt: parsed.lastSuccessAt ?? null,
    consecutiveFailures: parsed.consecutiveFailures ?? 0,
    lastError: parsed.lastError ?? null,
    model: parsed.model ?? null,
    effort: parsed.effort ?? null,
    // Absent on every record written before this field existed, which is
    // exactly the population that must migrate.
    pinResolved: parsed.pinResolved ?? false,
  };
}

/** A record for a workspace that has never had a session. */
function blankRecord(workspacePath: string): BridgeThreadRecord {
  return hydrate({}, workspacePath);
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
    const parsed = JSON.parse(
      readFileSync(path, "utf8")
    ) as Partial<BridgeThreadRecord>;
    return hydrate(parsed, workspacePath);
  } catch {
    return null;
  }
}

/** Load the record for a workspace, or return a fresh default if
 * none exists yet. Never throws on missing file. */
export function loadBridgeThreadRecord(workspacePath: string): BridgeThreadRecord {
  const path = recordPath(workspacePath);
  if (!existsSync(path)) return blankRecord(workspacePath);
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8")
    ) as Partial<BridgeThreadRecord>;
    return hydrate(parsed, workspacePath);
  } catch {
    return blankRecord(workspacePath);
  }
}

/** Atomic write via tmp + rename. Persists per-workspace bridge thread
 * state to `~/.wat321/epic-handshake/bridge-thread.<wsHash>.json`.
 *
 * Returns false on rename failure (e.g. EBUSY) rather than throwing, so
 * a caller can re-call to retry. Callers that are about to destroy the
 * only other copy of some state MUST check it: the pin migration deletes
 * the legacy flag files it just read, and doing that after a failed
 * write would lose the user's model choice outright. */
export function saveBridgeThreadRecord(record: BridgeThreadRecord): boolean {
  const path = recordPath(record.workspacePath);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return writeFileAtomic(path, JSON.stringify(record, null, 2));
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
 * creates a fresh Codex thread with S<N+1>.
 *
 * Model and effort are dropped along with the thread. A pin belongs to
 * the session that carried it, so S<N+1> is born on whatever Codex
 * recommends at that moment rather than inheriting the choice its
 * predecessor made. That is what makes "delete the session" the way a
 * user gets back to Codex's current default. */
export function resetBridgeThread(workspacePath: string): BridgeThreadRecord {
  const current = loadBridgeThreadRecord(workspacePath);
  const next: BridgeThreadRecord = {
    ...current,
    threadId: null,
    sessionCounter: current.sessionCounter + 1,
    lastResetAt: new Date().toISOString(),
    model: null,
    effort: null,
    pinResolved: true,
  };
  saveBridgeThreadRecord(next);
  return next;
}
