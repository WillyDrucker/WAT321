import {
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
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

export function recordPath(workspacePath: string): string {
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

/** Atomic write via tmp + rename. Returns silently on rename failure
 * (e.g. EBUSY); caller can re-call to retry. Persists per-workspace
 * bridge thread state to `~/.wat321/epic-handshake/bridge-thread.<wsHash>.json`. */
export function saveBridgeThreadRecord(record: BridgeThreadRecord): void {
  const path = recordPath(record.workspacePath);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileAtomic(path, JSON.stringify(record, null, 2));
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
