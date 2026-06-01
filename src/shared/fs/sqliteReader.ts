import { existsSync, statSync } from "node:fs";

/**
 * Minimal read-only wrapper around the built-in `node:sqlite` module.
 * Best-effort: every operation that can fail returns `null` / `[]`
 * instead of throwing so callers can fall through to a lower tier.
 * Runtime check at open time so older Electron without `node:sqlite`
 * degrades to "tier returns nothing" automatically.
 *
 * Read-only is load-bearing: VS Code holds `state.vscdb` open in WAL
 * mode and the Codex extension holds `logs_*.sqlite` open the same
 * way. Read-only opens share-lock cleanly with the writer; a
 * read-write open would compete for the exclusive lock and race.
 */

import type { DatabaseSync } from "node:sqlite";

export type SqliteRow = Record<
  string,
  null | number | bigint | string | Uint8Array
>;

export interface SqliteReader {
  /** Run `sql` with optional params; return the first row or `null`. */
  get(sql: string, params?: ReadonlyArray<string | number>): SqliteRow | null;
  /** Run `sql` with optional params; return every row (possibly empty). */
  all(sql: string, params?: ReadonlyArray<string | number>): SqliteRow[];
  /** Release the SQLite handle. Idempotent; safe to call twice. */
  close(): void;
}

let cachedSqliteModule: typeof import("node:sqlite") | null | undefined;

/** Load `node:sqlite` once and cache for the extension host's lifetime.
 * Both success (module reference) and failure (`null` when the runtime
 * does not expose the module) are cached so the per-poll overhead is a
 * map lookup. A VS Code version upgrade only takes effect after the
 * extension host reloads, which is when this cache resets too. */
function loadSqlite(): typeof import("node:sqlite") | null {
  if (cachedSqliteModule !== undefined) return cachedSqliteModule;
  let mod: typeof import("node:sqlite") | null;
  try {
    mod = require("node:sqlite");
  } catch {
    mod = null;
  }
  cachedSqliteModule = mod;
  return mod;
}

/** Open `path` read-only. Returns `null` when the file is missing,
 * the runtime lacks `node:sqlite`, or the open itself fails (locked,
 * corrupt, permission). The caller MUST close() the returned reader.
 *
 * Pair this with `statMtimeMs` from a previous poll: only reopen when
 * mtime advances, since each open + statement preparation is ~1-2ms
 * and the underlying file does not change between turn events. */
export function openSqliteReadOnly(path: string): SqliteReader | null {
  if (!existsSync(path)) return null;

  const mod = loadSqlite();
  if (!mod) return null;

  let db: DatabaseSync;
  try {
    db = new mod.DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }

  return {
    get(sql, params = []) {
      try {
        const stmt = db.prepare(sql);
        const row = stmt.get(...params);
        return (row as SqliteRow | undefined) ?? null;
      } catch {
        return null;
      }
    },
    all(sql, params = []) {
      try {
        const stmt = db.prepare(sql);
        const rows = stmt.all(...params);
        return (rows as SqliteRow[]) ?? [];
      } catch {
        return [];
      }
    },
    close() {
      try {
        db.close();
      } catch {
        // Already closed or never opened cleanly; nothing to recover.
      }
    },
  };
}

/** Returns the file's mtime in ms, or `null` if the file does not
 * exist or the stat fails. Used as the gate to skip the reopen path
 * when nothing has changed since the last poll. */
export function statMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
