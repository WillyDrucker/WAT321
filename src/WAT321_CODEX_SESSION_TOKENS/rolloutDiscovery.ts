import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { CodexSessionIndex } from "./types";
import { normalizePath } from "../shared/fs/pathUtils";
import { parseCwd } from "./parsers";

/**
 * Walks Codex's date-sharded rollout tree and picks the most recent
 * rollout whose `session_meta.cwd` matches the current workspace. Also
 * resolves session titles from `session_index.jsonl`.
 *
 * Codex keeps rollouts under `~/.codex/sessions/YYYY/MM/DD/`, sorted
 * lexically by path. Walking in reverse-sorted order visits newest
 * first, so the first match is the winner.
 */

/** Find the most recent rollout JSONL whose `session_meta.cwd` matches
 * the current workspace path. Walks `~/.codex/sessions/YYYY/MM/DD/` in
 * reverse date order. Returns `null` if nothing matches. */
export function findLatestRollout(
  codexDir: string,
  workspacePath: string
): string | null {
  const sessionsDir = join(codexDir, "sessions");
  if (!existsSync(sessionsDir)) return null;

  const wsNorm = normalizePath(workspacePath);

  try {
    const years = readdirSync(sessionsDir).sort().reverse();
    for (const year of years) {
      const yearDir = join(sessionsDir, year);
      if (!statSync(yearDir).isDirectory()) continue;

      const months = readdirSync(yearDir).sort().reverse();
      for (const month of months) {
        const monthDir = join(yearDir, month);
        if (!statSync(monthDir).isDirectory()) continue;

        const days = readdirSync(monthDir).sort().reverse();
        for (const day of days) {
          const dayDir = join(monthDir, day);
          if (!statSync(dayDir).isDirectory()) continue;

          const files = readdirSync(dayDir)
            .filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))
            .sort()
            .reverse();

          for (const file of files) {
            const fullPath = join(dayDir, file);
            const cwd = parseCwd(fullPath);
            if (!cwd) continue;
            const cwdNorm = normalizePath(cwd);
            if (
              wsNorm === "" ||
              cwdNorm === wsNorm ||
              wsNorm.startsWith(cwdNorm + "/")
            ) {
              return fullPath;
            }
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
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
