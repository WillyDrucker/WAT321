import { dirname, join } from "node:path";
import { openSqliteReadOnly, statMtimeMs } from "../shared/fs/sqliteReader";

/**
 * Reads the Claude Code extension's currently-selected session ID
 * out of VS Code's per-workspace `state.vscdb`. The Memento key
 * `memento/webviewView.claudeVSCodeSidebarSecondary` is the only
 * first-class "user intent" signal available - no public API, no
 * event, no command exposes it. Claude Code writes it synchronously
 * on every user click in the session switcher.
 *
 * Concurrent sessions in the same workspace can pass freshness +
 * classify pending + sit inside the hot-recency window simultaneously;
 * the activity-first ranker + hot-recency tier cannot disambiguate
 * them and the widget flips every few seconds. The Memento read
 * returns the session the user actually clicked - stable while disk
 * activity churns - and the ranker uses it as a top tier above
 * hot-recency. Falls through cleanly when the Memento is absent or
 * unreadable so the existing tiers still apply.
 *
 * Persisted value is a nested JSON envelope: VS Code JSON-encodes the
 * outer Memento, the Claude extension JSON-encodes its inner state
 * inside that. Each pass returns null cleanly on failure (format
 * drift, partial write).
 *
 * Stat-gated by `state.vscdb` mtime so SQLite reopens only when the
 * file actually changed.
 */

/** VS Code Memento key the Claude Code extension writes its
 * sidebar webview state under. The view-id portion is declared in
 * the extension's `package.json contributes.views`; renaming it
 * would break the extension's own session restoration, so this
 * string is effectively stable. We still probe-first-then-fall-back
 * so a future rename degrades gracefully instead of throwing. */
const CLAUDE_MEMENTO_KEY =
  "memento/webviewView.claudeVSCodeSidebarSecondary";

export interface SelectedSession {
  /** Session UUID. Matches the filename (minus `.jsonl`) under
   * `~/.claude/projects/<projectKey>/`. */
  sessionId: string;
  /** Epoch ms when the user clicked the session in the switcher.
   * `null` when the inner state lacks the field (older extension
   * release or partial write). */
  selectedAt: number | null;
  /** Whether the user has the full-editor view open instead of the
   * sidebar. Carried through for the diagnostic surface; the ranker
   * itself does not distinguish the two locations. */
  isFullEditor: boolean;
}

interface CacheEntry {
  mtime: number;
  result: SelectedSession | null;
}

/** Per-path cache. Key is the state.vscdb absolute path; value is
 * the last-seen mtime + the parse result. Multi-window scenarios
 * with different workspaces each cache against their own path; a
 * single workspace open in two VS Code windows shares the same
 * state.vscdb path and therefore the same cache entry, which is
 * what we want - the LAST write wins per VS Code's own semantics. */
const cache = new Map<string, CacheEntry>();

/** Derive the absolute path to `state.vscdb` from the extension's
 * own per-workspace storage directory. The extension storageUri
 * points at `<workspaceStorage>/<wsHash>/<publisher>.<name>/`; the
 * `state.vscdb` we want is one directory up. Going via the
 * extension's own storageUri sidesteps the question of how VS Code
 * computes `<wsHash>` (md5 of the workspace URI, but the exact
 * normalization is an implementation detail). */
export function resolveStateVscdbPath(
  extensionStorageDir: string
): string {
  return join(dirname(extensionStorageDir), "state.vscdb");
}

/** Read the persisted selected-session memento from `state.vscdb`.
 * Returns null on every failure mode (file absent, runtime lacks
 * `node:sqlite`, SQLite open fails under lock, memento key absent,
 * envelope malformed). Cached per-path on mtime so back-to-back
 * polls without a user click hit memory instead of SQLite. */
export function readSelectedSession(
  stateVscdbPath: string
): SelectedSession | null {
  const mtime = statMtimeMs(stateVscdbPath);
  if (mtime === null) return null;

  const cached = cache.get(stateVscdbPath);
  if (cached && cached.mtime === mtime) return cached.result;

  const reader = openSqliteReadOnly(stateVscdbPath);
  if (!reader) {
    // Cache the failure too. A subsequent attempt on the same mtime
    // will not retry, but the mtime advances every time the
    // extension writes, which clears the failure cache naturally on
    // the very next user interaction. Avoids hammering SQLite when
    // it is genuinely locked.
    cache.set(stateVscdbPath, { mtime, result: null });
    return null;
  }

  let result: SelectedSession | null = null;
  try {
    const row = reader.get(
      "SELECT value FROM ItemTable WHERE key = ?",
      [CLAUDE_MEMENTO_KEY]
    );
    if (row && typeof row.value === "string") {
      result = parseMementoValue(row.value);
    }
  } finally {
    reader.close();
  }

  cache.set(stateVscdbPath, { mtime, result });
  return result;
}

/** Two-pass JSON parse of the persisted Memento value. The outer
 * envelope is what VS Code wrote; its `webviewState` field is the
 * Claude extension's own JSON-encoded state. Either pass can fail
 * (mid-write read, schema drift) - return null and let the ranker
 * fall through. */
function parseMementoValue(value: string): SelectedSession | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(value);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== "object") return null;
  const webviewState = (envelope as { webviewState?: unknown }).webviewState;
  if (typeof webviewState !== "string") return null;

  let inner: unknown;
  try {
    inner = JSON.parse(webviewState);
  } catch {
    return null;
  }
  if (!inner || typeof inner !== "object") return null;

  const obj = inner as {
    sessionID?: unknown;
    sessionUpdatedAt?: unknown;
    isFullEditor?: unknown;
  };
  if (typeof obj.sessionID !== "string" || obj.sessionID.length === 0) {
    return null;
  }
  return {
    sessionId: obj.sessionID,
    selectedAt:
      typeof obj.sessionUpdatedAt === "number" ? obj.sessionUpdatedAt : null,
    isFullEditor:
      typeof obj.isFullEditor === "boolean" ? obj.isFullEditor : false,
  };
}

/** Service `reset()` calls this so a workspace switch (or a Reset
 * WAT321 sweep) does not leave a stale Memento cached from the
 * prior workspace. The cache is keyed by absolute path so a sibling
 * workspace's entry is untouched. */
export function resetSelectedSessionCache(): void {
  cache.clear();
}
