import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { openSqliteReadOnly, statMtimeMs } from "../shared/fs/sqliteReader";

/**
 * Reads Codex VS Code extension activity from `~/.codex/logs_*.sqlite`.
 * Analog of the CLI's rollout-JSONL files for the native extension
 * panel - CLI rollouts don't capture extension-panel turns.
 *
 * Workspace-scoped: the SQLite store is account-global; rows are
 * filtered by workspace marker (absolute path or basename match in
 * `feedback_log_body`). Cache keyed by (workspacePath, sqliteFile).
 * Stat-gated on the file mtime.
 *
 * Classifier surfaces turn-state only (`user` / `assistant-pending` /
 * `assistant-done`); token + model fields are not exposed here.
 */

/** Snapshot of the most-recent extension activity for a workspace.
 * `null` from the scanner when no `logs_*.sqlite` exists or no
 * recent activity rows match the query (the extension has never
 * been opened, or has been idle longer than the lookback window). */
export interface CodexExtensionActivity {
  /** Thread id of the most-recent active session in this logs DB.
   * Stable across a single conversation's turns; rotates on a fresh
   * thread. */
  threadId: string;
  /** Activity timestamp in epoch ms, reconstructed from the SQLite
   * row's `ts` (unix seconds) and `ts_nanos` (sub-second precision).
   * Drives the widget's freshness / hot-recency check. */
  activeAt: number;
  /** Latest classified turn state. Classification rules live with
   * `classifyBody`. */
  turnState: "user" | "assistant-pending" | "assistant-done" | "unknown";
  /** Absolute path to the `logs_*.sqlite` we read from. Diagnostics
   * surface only; the widget itself does not use this. */
  sqliteFile: string;
}

/** Pick the newest `logs_*.sqlite` in `codexDir` by mtime. The
 * extension rolls its logs database periodically (the `_N` suffix
 * increments on rollover - we saw `_2` in the wild) so the active
 * file is not always the same name across versions. Returns `null`
 * when no matching file exists or `codexDir` itself is missing. */
function pickActiveLogsDb(codexDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(codexDir);
  } catch {
    return null;
  }
  let bestPath: string | null = null;
  let bestMtime = 0;
  for (const e of entries) {
    if (!e.startsWith("logs_") || !e.endsWith(".sqlite")) continue;
    const full = join(codexDir, e);
    try {
      const m = statSync(full).mtimeMs;
      if (m > bestMtime) {
        bestPath = full;
        bestMtime = m;
      }
    } catch {
      // skip files we can't stat
    }
  }
  return bestPath;
}

interface CacheEntry {
  mtime: number;
  result: CodexExtensionActivity | null;
}
const cache = new Map<string, CacheEntry>();

function cacheKey(workspacePath: string, sqliteFile: string): string {
  return `${workspacePath}::${sqliteFile}`;
}

/** Wider window than the inline classifier needs so the in-process
 * workspace filter has headroom for non-matching rows. */
const SCAN_LIMIT_WITH_WORKSPACE_FILTER = 64;

/** Normalize a path for substring matching: lowercase + forward
 * slashes + drop trailing slash. The Codex extension OpenTelemetry
 * log can emit the cwd in either separator and case-insensitive
 * comparison is required on Windows. */
function normalizeForMatch(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** True when the row body, normalized for case + slash, contains the
 * normalized absolute workspace path. Basename-only matches are not
 * accepted because sibling workspaces sharing a leaf folder name would
 * false-positive. */
function rowMatchesWorkspace(
  row: Record<string, unknown>,
  workspaceNorm: string
): boolean {
  if (!workspaceNorm) return false;
  const body = normalizeForMatch(String(row.feedback_log_body ?? ""));
  return body.includes(workspaceNorm);
}

/** Read the latest Codex VS Code extension activity for the supplied
 * workspace. Returns null when the file does not exist, the runtime
 * lacks `node:sqlite`, the query fails, or no rows carry the
 * workspace marker. Stat-gated per (workspace, file) pair. */
export function readLatestExtensionActivity(
  codexDir: string,
  workspacePath: string
): CodexExtensionActivity | null {
  if (!workspacePath) return null;
  const sqliteFile = pickActiveLogsDb(codexDir);
  if (!sqliteFile) return null;

  // SQLite WAL mode lands fresh rows in `<file>-wal` before
  // checkpointing back; the main file's mtime stays unchanged until
  // checkpoint. Combine both so cached results invalidate on either.
  const baseMtime = statMtimeMs(sqliteFile);
  if (baseMtime === null) return null;
  const walMtime = statMtimeMs(`${sqliteFile}-wal`) ?? 0;
  const mtime = Math.max(baseMtime, walMtime);

  const key = cacheKey(workspacePath, sqliteFile);
  const cached = cache.get(key);
  if (cached && cached.mtime === mtime) return cached.result;

  const reader = openSqliteReadOnly(sqliteFile);
  if (!reader) {
    // Failure-cache same as the Claude memento path: we stop retrying
    // until the file's mtime advances, which it will on the very next
    // extension log write.
    cache.set(key, { mtime, result: null });
    return null;
  }

  const workspaceNorm = normalizeForMatch(workspacePath);
  let result: CodexExtensionActivity | null = null;
  try {
    // The composite index `idx_logs_thread_id_ts` makes this an
    // index-only seek - O(log N) regardless of how many millions of
    // rows the DB has accumulated. We filter by `thread_id IS NOT
    // NULL` so generic network/log rows (the WebSocket frame trace
    // noise) cannot mask a real turn.
    const rows = reader.all(
      `SELECT thread_id, ts, ts_nanos, target, feedback_log_body
       FROM logs
       WHERE thread_id IS NOT NULL
       ORDER BY id DESC
       LIMIT ?`,
      [SCAN_LIMIT_WITH_WORKSPACE_FILTER]
    );
    // In-process workspace filter; SQLite LIKE on feedback_log_body
    // would defeat the composite index.
    const matching = rows.filter((r) => rowMatchesWorkspace(r, workspaceNorm));
    if (matching.length > 0) {
      result = classifyRows(matching, sqliteFile);
    }
  } finally {
    reader.close();
  }

  cache.set(key, { mtime, result });
  return result;
}

/** Reduce the scanned log rows to one activity snapshot for the
 * most-recent thread. The latest row's `thread_id` wins (every row
 * is sorted by id DESC). The classifier walks the row's
 * `feedback_log_body` for the markers that distinguish the three
 * meaningful turn states. */
function classifyRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  sqliteFile: string
): CodexExtensionActivity {
  const head = rows[0];
  const threadId = String(head.thread_id ?? "");
  const ts = Number(head.ts ?? 0);
  const tsNanos = Number(head.ts_nanos ?? 0);
  const activeAt = ts * 1000 + Math.floor(tsNanos / 1_000_000);
  const turnState = classifyBody(rows, threadId);
  return { threadId, activeAt, turnState, sqliteFile };
}

/** Walk the recent rows (newest first) for the markers that
 * disambiguate the turn state. The "post sampling token usage"
 * substring is the terminal completion log emitted exactly once
 * per turn; finding it as the freshest hit means the turn is done.
 * "op.dispatch.user_input" without a subsequent completion is the
 * submission-just-landed window. Anything else thread-scoped is the
 * mid-turn streaming/tool/handler activity. */
function classifyBody(
  rows: ReadonlyArray<Record<string, unknown>>,
  threadId: string
): "user" | "assistant-pending" | "assistant-done" | "unknown" {
  let sawSubmission = false;
  for (const row of rows) {
    if (String(row.thread_id ?? "") !== threadId) continue;
    const body = String(row.feedback_log_body ?? "");
    if (body.includes("post sampling token usage")) return "assistant-done";
    if (body.includes('otel.name="op.dispatch.user_input"')) {
      sawSubmission = true;
    }
  }
  // No completion marker in the recent window. If we saw the
  // submission span, the turn is between submission and completion
  // (or the completion log has not landed yet in this poll). Any
  // other thread-scoped activity in the window without a submission
  // is the assistant in mid-stream - treat as pending. The "user"
  // state collapses into "assistant-pending" once dispatch fires,
  // which the codex_core::session::turn rows confirm immediately;
  // we report `user` only for the brief window where the submission
  // is the freshest signal we have.
  return sawSubmission ? "user" : "assistant-pending";
}

/** Reset the per-file cache. Service reset() calls this so a
 * workspace switch (or Reset WAT321) does not return a stale
 * result for the new context. */
export function resetExtensionActivityCache(): void {
  cache.clear();
}
