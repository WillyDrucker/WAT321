import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CodexSessionIndex } from "./types";
import { normalizePath } from "../shared/fs/pathUtils";
import { parseCwd } from "./parsers";

/**
 * Walks Codex's date-sharded rollout tree and picks the active
 * rollout for the current workspace. Also resolves session titles
 * from `session_index.jsonl`.
 *
 * Codex keeps rollouts under `~/.codex/sessions/YYYY/MM/DD/`. The
 * filename encodes the session CREATION timestamp, but users
 * regularly return to older sessions - those files then get mtime
 * updates without a filename change. Ranking by filename alone
 * misses the case where the active session has an older name but
 * was most recently written to. We rank by file mtime instead to
 * reflect actual recent use.
 *
 * The walk is bounded to a recent window so a machine with years
 * of rollouts does not pay the stat cost on every cycle. Within
 * the window we skip `parseCwd` (first-line read) for files older
 * than the current best candidate by mtime.
 */

/** How many calendar day-directories back we walk. 30 days covers
 * any realistic active-session age; older rollouts are ignored. */
const MAX_DAYS_TO_SCAN = 30;

/** Find the rollout JSONL most recently written to whose
 * `session_meta.cwd` matches the current workspace. Returns `null`
 * if no match exists in the scan window. */
export function findLatestRollout(
  codexDir: string,
  workspacePath: string
): string | null {
  const sessionsDir = join(codexDir, "sessions");
  if (!existsSync(sessionsDir)) return null;

  const wsNorm = normalizePath(workspacePath);

  let bestPath: string | null = null;
  let bestMtime = 0;
  let daysScanned = 0;

  try {
    const years = readdirSync(sessionsDir).sort().reverse();
    for (const year of years) {
      const yearDir = join(sessionsDir, year);
      try { if (!statSync(yearDir).isDirectory()) continue; } catch { continue; }

      const months = readdirSync(yearDir).sort().reverse();
      for (const month of months) {
        const monthDir = join(yearDir, month);
        try { if (!statSync(monthDir).isDirectory()) continue; } catch { continue; }

        const days = readdirSync(monthDir).sort().reverse();
        for (const day of days) {
          if (daysScanned >= MAX_DAYS_TO_SCAN) return bestPath;
          daysScanned++;

          const dayDir = join(monthDir, day);
          try { if (!statSync(dayDir).isDirectory()) continue; } catch { continue; }

          let files: string[];
          try {
            files = readdirSync(dayDir)
              .filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
          } catch {
            continue;
          }

          for (const file of files) {
            const fullPath = join(dayDir, file);
            let mtime = 0;
            try {
              mtime = statSync(fullPath).mtimeMs;
            } catch {
              continue;
            }
            // Skip the cwd read (opens the file) when this rollout
            // cannot beat the current best mtime. Most files in
            // older day-dirs are immediately rejected this way.
            if (mtime <= bestMtime) continue;

            const cwd = parseCwd(fullPath);
            if (!cwd) continue;
            const cwdNorm = normalizePath(cwd);
            const matches =
              wsNorm === "" ||
              cwdNorm === wsNorm ||
              wsNorm.startsWith(`${cwdNorm}/`);
            if (!matches) continue;

            bestPath = fullPath;
            bestMtime = mtime;
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return bestPath;
}

/** Look up a session's thread name from `~/.codex/session_index.jsonl`
 * by matching session ID. Walks the file from newest entry to oldest
 * because session_index is append-only. */
export function getSessionTitle(
  codexDir: string,
  sessionId: string
): string {
  const indexPath = join(codexDir, "session_index.jsonl");
  if (!existsSync(indexPath)) return "";

  try {
    const content = readFileSync(indexPath, "utf8");
    const lines = content.trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const entry: CodexSessionIndex = JSON.parse(line);
        if (entry.id === sessionId) return entry.thread_name || "";
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }
  return "";
}
