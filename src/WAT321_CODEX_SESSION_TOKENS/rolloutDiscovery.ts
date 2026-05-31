import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CodexSessionIndex } from "./types";
import { readTail } from "../shared/fs/fileReaders";
import { normalizePath } from "../shared/fs/pathUtils";
import { classifyCodexTurn, parseCwd } from "./parsers";

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
 * the stat cost on every cycle.
 *
 * Ranking is activity-first, not mtime-first: in a workspace where
 * the EH bridge writes rollouts on most prompts, the bridge wins
 * pure mtime competition against a freshly-typed-into native Codex
 * VS Code session, leaving the user's actual session invisible to
 * the widget. We instead read each candidate's tail, classify its
 * last turn (`assistant-pending` > `user` > `assistant-done` >
 * `unknown`), and break ties by file mtime. This way:
 *   - Bridge mid-dispatch wins when nothing else is active.
 *   - A native session the user is prompting wins over an idle bridge
 *     even when the bridge's last rollout write was more recent.
 *   - When two sessions are concurrently active, the most-recent
 *     write breaks the tie.
 */

/** How many calendar day-directories back we walk. 30 days covers
 * any realistic active-session age; older rollouts are ignored. */
const MAX_DAYS_TO_SCAN = 30;

/** Per-candidate activity weight from the tail classifier. Larger
 * means "this session is more deserving of widget focus right now".
 * Sequence rationale: an in-flight assistant turn is the strongest
 * signal (something is actively happening), a pending user prompt is
 * the next strongest (user just typed and is waiting), and a done /
 * unknown tail is idle. */
const ACTIVITY_SCORE: Record<string, number> = {
  "assistant-pending": 3,
  user: 2,
  "assistant-done": 1,
  unknown: 0,
};

/** Freshness gate for the activity-first ranking. A rollout whose
 * tail still classifies as `assistant-pending` but whose mtime is
 * older than this window is treated as stale (activity score forced
 * to 0) so an orphaned mid-write rollout from days ago can't outrank
 * a freshly-active session. 5 minutes covers the longest reasonable
 * in-flight Codex turn while excluding stale tails. Candidates outside
 * the window still compete on mtime. */
const ACTIVITY_FRESHNESS_MS = 5 * 60_000;

/** Find the rollout JSONL the widget should track for the current
 * workspace. Ranks by activity-then-mtime so a concurrently-active
 * native Codex session wins against an idle bridge rollout even when
 * the bridge's last write was newer. Returns `null` if no match
 * exists in the scan window. */
export function findLatestRollout(
  codexDir: string,
  workspacePath: string
): string | null {
  const sessionsDir = join(codexDir, "sessions");
  if (!existsSync(sessionsDir)) return null;

  const wsNorm = normalizePath(workspacePath);

  interface Candidate {
    path: string;
    mtime: number;
    activity: number;
  }
  const candidates: Candidate[] = [];
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
          if (daysScanned >= MAX_DAYS_TO_SCAN) {
            return rankCandidates(candidates);
          }
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

            const cwd = parseCwd(fullPath);
            if (!cwd) continue;
            const cwdNorm = normalizePath(cwd);
            const matches =
              wsNorm === "" ||
              cwdNorm === wsNorm ||
              wsNorm.startsWith(`${cwdNorm}/`);
            if (!matches) continue;

            // Read the tail to classify activity. Bounded to the tail
            // window so this stays cheap even on multi-MB rollouts.
            // Freshness-gated: a non-zero activity score only counts
            // when the rollout was written within ACTIVITY_FRESHNESS_MS.
            // Outside that window the tail's classification is treated
            // as stale (often an orphaned mid-write from days ago) and
            // the candidate competes on mtime alone.
            const tail = readTail(fullPath);
            const turnState = tail ? classifyCodexTurn(tail) : "unknown";
            const rawActivity = ACTIVITY_SCORE[turnState] ?? 0;
            const fresh = Date.now() - mtime <= ACTIVITY_FRESHNESS_MS;
            const activity = fresh ? rawActivity : 0;

            candidates.push({ path: fullPath, mtime, activity });
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return rankCandidates(candidates);
}

/** Pick the most deserving candidate: activity desc, then mtime desc.
 * Returns null on empty list. */
function rankCandidates(
  candidates: { path: string; mtime: number; activity: number }[]
): string | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    if (
      c.activity > best.activity ||
      (c.activity === best.activity && c.mtime > best.mtime)
    ) {
      best = c;
    }
  }
  return best.path;
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
