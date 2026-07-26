import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CodexSessionIndex } from "./types";
import { readTail } from "../shared/fs/fileReaders";
import { normalizePath } from "../shared/fs/pathUtils";
import { parseSessionMeta } from "./parsers";
import { classifyCodexTurn } from "./turnClassifier";

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
 * any realistic active-session age - older rollouts are ignored. */
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

/** Hot-recency window. A rollout written within this window
 * outranks every rollout outside it regardless of activity score,
 * so a session the user just touched wins against a sibling whose
 * mid-turn classification is older but technically still inside
 * the 5-minute activity window. Symmetric with the Claude side.
 *
 * Trade-off the constant encodes: a Codex turn that goes silent
 * for more than this (deep model reasoning with no rollout writes,
 * external tool dispatch) drops out of "hot" even though the user
 * is still waiting for it. Picked to be longer than a typical
 * between-write gap during normal turns and short enough that a
 * stale background session loses preference quickly once the user
 * moves on. */
const HOT_RECENCY_MS = 60_000;

/** How recent a rollout's mtime must be to count toward the
 * workspace inventory. 30 minutes captures "actually open" without
 * counting yesterday's leftover rollouts as part of the
 * "multi-session" surface. Same window is used to gate the
 * in-progress sub-count. */
const INVENTORY_WINDOW_MS = 30 * 60_000;

export interface RolloutDiscoveryResult {
  /** The rollout to track, or null if no workspace match exists. */
  path: string | null;
  /** Count of rollouts in this workspace with mtime within the
   * inventory window. Drives the multi-session tooltip. */
  total: number;
  /** Subset of `total` whose tail classifies as a turn in progress
   * (`assistant-pending` or `user`). */
  inProgress: number;
  /** Every workspace-matching candidate from this walk. Empty when
   * no workspace match exists. */
  candidates: RolloutCandidate[];
}

export interface RolloutCandidate {
  path: string;
  mtime: number;
  turnState: "user" | "assistant-pending" | "assistant-done" | "unknown";
  cwd: string;
}

/** Internal scoring shape for one rollout candidate, richer than the
 * exported RolloutCandidate (carries the ranking inputs). */
interface Candidate {
  path: string;
  mtime: number;
  activity: number;
  inProgress: boolean;
  fresh: boolean;
  isHot: boolean;
  turnState: RolloutCandidate["turnState"];
  cwd: string;
}

/** Stat + classify one rollout file into a ranking candidate, or null
 * when it cannot be read or its cwd does not belong to this workspace.
 * Shared by the day-window walk and the sticky-path injection so both
 * score a candidate identically. */
function buildCandidate(
  fullPath: string,
  wsNorm: string,
  now: number
): Candidate | null {
  let mtime = 0;
  try {
    mtime = statSync(fullPath).mtimeMs;
  } catch {
    return null;
  }

  const meta = parseSessionMeta(fullPath);
  if (!meta || meta.isSubagent) return null;
  const { cwd } = meta;
  const cwdNorm = normalizePath(cwd);
  // Bidirectional match, symmetric with Claude's walkWorkspaceSessions:
  // also matches a native session launched from a subfolder of the open
  // workspace.
  const matches =
    wsNorm === "" ||
    cwdNorm === wsNorm ||
    wsNorm.startsWith(`${cwdNorm}/`) ||
    cwdNorm.startsWith(`${wsNorm}/`);
  if (!matches) return null;

  // Read the tail to classify activity. Bounded to the tail window so
  // this stays cheap even on multi-MB rollouts. Freshness-gated: a
  // non-zero activity score only counts when the rollout was written
  // within ACTIVITY_FRESHNESS_MS. Outside that window the tail's
  // classification is treated as stale (often an orphaned mid-write
  // from days ago) and the candidate competes on mtime alone.
  const tail = readTail(fullPath);
  const rawTurnState = tail ? classifyCodexTurn(tail) : "unknown";
  // Narrow LastEntryKind to the three states the candidate carries -
  // compact-end / interrupted collapse to unknown.
  const turnState: RolloutCandidate["turnState"] =
    rawTurnState === "user" ||
    rawTurnState === "assistant-pending" ||
    rawTurnState === "assistant-done"
      ? rawTurnState
      : "unknown";
  const rawActivity = ACTIVITY_SCORE[rawTurnState] ?? 0;
  const activityFresh = now - mtime <= ACTIVITY_FRESHNESS_MS;
  const activity = activityFresh ? rawActivity : 0;
  const inventoryFresh = now - mtime <= INVENTORY_WINDOW_MS;
  const isHot = now - mtime <= HOT_RECENCY_MS;
  const inProgress = turnState === "assistant-pending" || turnState === "user";

  return {
    path: fullPath,
    mtime,
    activity,
    inProgress,
    fresh: inventoryFresh,
    isHot,
    turnState,
    cwd,
  };
}

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
  const candidates: Candidate[] = [];
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
            const candidate = buildCandidate(join(dayDir, file), wsNorm, now);
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
  // can still take over. buildCandidate re-applies the workspace cwd gate,
  // so a sticky path can never widen scope to another project's session -
  // discovery stays strictly project-scoped (no cross-instance leakage).
  if (stickyPath && !candidates.some((c) => c.path === stickyPath)) {
    const sticky = buildCandidate(stickyPath, wsNorm, now);
    if (sticky) candidates.push(sticky);
  }

  return rankCandidates(candidates);
}

/** Tiered ranking: hot-recency > activity > mtime. A rollout written
 * within HOT_RECENCY_MS outranks any rollout outside it regardless
 * of activity score so a session the user just touched wins against
 * a sibling whose mid-turn classification is older. Inside the same
 * hot bucket, activity-then-mtime applies as before. Tallies the
 * inventory (count of fresh rollouts in workspace + those with
 * in-flight turns) from the same candidate list so the widget
 * tooltip surfaces multi-session disclosure without a second walk.
 * Returns `{ path: null, total: 0, inProgress: 0 }` on empty list. */
function rankCandidates(candidates: Candidate[]): RolloutDiscoveryResult {
  let total = 0;
  let inProgress = 0;
  for (const c of candidates) {
    if (!c.fresh) continue;
    total++;
    if (c.inProgress) inProgress++;
  }
  const exposedCandidates: RolloutCandidate[] = candidates.map((c) => ({
    path: c.path,
    mtime: c.mtime,
    turnState: c.turnState,
    cwd: c.cwd,
  }));
  if (candidates.length === 0) {
    return { path: null, total: 0, inProgress: 0, candidates: exposedCandidates };
  }
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const beats =
      (c.isHot && !best.isHot) ||
      (c.isHot === best.isHot &&
        (c.activity > best.activity ||
          (c.activity === best.activity && c.mtime > best.mtime)));
    if (beats) best = c;
  }
  return { path: best.path, total, inProgress, candidates: exposedCandidates };
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
