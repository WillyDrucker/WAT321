import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizePath } from "../engine/fs/pathIdentity";
import type { CodexSessionIndex } from "./codexSessionTokenTypes";
import {
  rankRollouts,
  scoreRollout,
  type RolloutDiscoveryResult,
  type ScoredRollout,
} from "./rolloutRanking";

/**
 * Walks Codex's date-sharded rollout tree and picks the active
 * rollout for the current workspace. Also resolves session titles
 * from `session_index.jsonl`.
 *
 * Codex keeps rollouts under `~/.codex/sessions/YYYY/MM/DD/`. The
 * filename encodes the session CREATION timestamp, but users
 * regularly return to older sessions - those files then get mtime
 * updates without a filename change. The walk is bounded to a
 * recent window so a machine with years of rollouts does not pay
 * the stat cost on every cycle. Scoring and ranking live in
 * `rolloutRanking.ts`.
 */


/** How many calendar day-directories back we walk. 30 days covers
 * any realistic active-session age - older rollouts are ignored. */
const MAX_DAYS_TO_SCAN = 30;

/** Find the rollout JSONL the widget should track for the current
 * workspace AND tally how many sibling rollouts in the same
 * workspace are currently open (with how many in-progress). Ranks
 * the active pick by activity-then-mtime so a concurrently-active
 * native Codex session wins against an idle bridge rollout even
 * when the bridge's last write was newer. Inventory is computed in
 * the same walk so there is no extra cost. */
export function findLatestRollout(
  codexDir: string,
  workspacePath: string,
  stickyPath?: string | null
): RolloutDiscoveryResult {
  const sessionsDir = join(codexDir, "sessions");
  if (!existsSync(sessionsDir)) {
    return { path: null, total: 0, inProgress: 0, candidates: [] };
  }

  const wsNorm = normalizePath(workspacePath);
  const now = Date.now();
  const candidates: ScoredRollout[] = [];
  let daysScanned = 0;

  try {
    const years = readdirSync(sessionsDir).sort().reverse();
    outer: for (const year of years) {
      const yearDir = join(sessionsDir, year);
      try { if (!statSync(yearDir).isDirectory()) continue; } catch { continue; }

      const months = readdirSync(yearDir).sort().reverse();
      for (const month of months) {
        const monthDir = join(yearDir, month);
        try { if (!statSync(monthDir).isDirectory()) continue; } catch { continue; }

        const days = readdirSync(monthDir).sort().reverse();
        for (const day of days) {
          if (daysScanned >= MAX_DAYS_TO_SCAN) break outer;
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
            const candidate = scoreRollout(join(dayDir, file), wsNorm, now);
            if (candidate) candidates.push(candidate);
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // Keep an already-tracked session in contention even after its rollout
  // has aged past the day-window walk above. A long-running Codex session
  // appends to one file in its CREATION-date directory for its whole life,
  // so once that directory falls outside MAX_DAYS_TO_SCAN the walk can no
  // longer reach it. Re-score the sticky path directly so it competes on
  // the same activity-then-recency footing, and a genuinely newer session
  // can still take over. scoreRollout re-applies the workspace cwd gate,
  // so a sticky path can never widen scope to another project's session -
  // discovery stays strictly project-scoped (no cross-instance leakage).
  if (stickyPath && !candidates.some((c) => c.path === stickyPath)) {
    const sticky = scoreRollout(stickyPath, wsNorm, now);
    if (sticky) candidates.push(sticky);
  }

  return rankRollouts(candidates);
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
