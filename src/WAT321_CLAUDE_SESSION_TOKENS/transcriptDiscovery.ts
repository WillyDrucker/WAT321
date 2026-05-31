import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionEntry } from "./types";
import { readTail } from "../shared/fs/fileReaders";
import { getProjectKey, normalizePath } from "../shared/fs/pathUtils";
import {
  classifyLastEntry,
  type LastEntryKind,
} from "../shared/transcriptClassifier";
import { parseCwd } from "./parsers";

/**
 * Resolves which Claude transcript a workspace should display.
 * `walkWorkspaceSessions` does the I/O once per poll;
 * `rankActiveSession` and `tallyWorkspaceSessions` are pure consumers
 * over that result. `findLastKnownTranscript` is the lastKnown
 * fallback when no live process matches.
 */

export interface LastKnownTranscript {
  sessionId: string;
  path: string;
  mtime: number;
  /** The cwd the transcript was originally recorded in, parsed from
   * the first line of the file. Used as the widget label so that a
   * cross-project fallback (transcript belongs to a different
   * workspace than the one VS Code is currently open in) shows the
   * actual project's basename instead of the wrong one. Empty when
   * the transcript could not be read or had no `cwd` field. */
  cwd: string;
}

/** Per-session snapshot surfaced by the walker. Carries every field
 * the rank and tally consumers need so neither has to re-read the
 * session file or the transcript tail. `turnState` is `"unknown"`
 * when the transcript could not be read; `mtime` falls back to
 * `entry.startedAt` in the same case. */
export interface SessionCandidate {
  entry: SessionEntry;
  transcriptPath: string;
  mtime: number;
  turnState: LastEntryKind;
}

const ACTIVITY_SCORE: Record<string, number> = {
  "assistant-pending": 3,
  user: 2,
  "assistant-done": 1,
  "compact-end": 0,
  interrupted: 0,
  unknown: 0,
};

/** Freshness gate for the activity-first ranking. A transcript whose
 * tail still classifies as `assistant-pending` but whose mtime is
 * older than this window is treated as stale (activity score forced
 * to 0) so an orphaned mid-turn transcript from days ago can't outrank
 * a freshly-active session. 5 minutes covers the longest reasonable
 * in-flight Claude turn while excluding stale tails. Candidates outside
 * the window still compete on mtime. */
const ACTIVITY_FRESHNESS_MS = 5 * 60_000;

/** Hot-recency window. A transcript written to within this window is
 * the strongest "user is here right now" signal the file system can
 * give us: either the user just typed, or Claude just streamed a
 * response, or both. Candidates inside this window outrank candidates
 * outside it regardless of activity score, so a session the user just
 * touched wins against a sibling whose mid-turn classification is
 * older but technically still inside the 5-minute activity window.
 *
 * Trade-off the constant encodes: a Claude turn that goes silent for
 * more than this (deep Opus thinking with no transcript writes, slow
 * tool dispatch) drops out of "hot" even though the user is still
 * waiting for it. Picked to be longer than a typical between-write
 * gap during normal turns and short enough that a stale background
 * session loses preference quickly once the user moves on. */
const HOT_RECENCY_MS = 60_000;

/** Walk `~/.claude/sessions/*.json` once and return every workspace-
 * matching session as a `SessionCandidate`. Bidirectional cwd match
 * closes a recurring widget-misses-the-live-session gap: when a user
 * launches `claude` from `c:\Dev\WAT321\subdir` but has VS Code open
 * at `c:\Dev\WAT321`, the unidirectional check "workspace is inside
 * session.cwd" fails and the live PID is never found. The reverse
 * check "session.cwd is inside workspace" recovers it. One tail read
 * per candidate, consumed by both rank and tally. */
export function walkWorkspaceSessions(
  sessionsDir: string,
  workspacePath: string
): SessionCandidate[] {
  if (!existsSync(sessionsDir)) return [];

  let files: string[];
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const wsNorm = normalizePath(workspacePath);
  const home = homedir();
  const candidates: SessionCandidate[] = [];

  for (const file of files) {
    try {
      const entry: SessionEntry = JSON.parse(
        readFileSync(join(sessionsDir, file), "utf8")
      );
      const entryCwd = normalizePath(entry.cwd);
      const match =
        wsNorm === ""
          ? true
          : entryCwd === wsNorm ||
            wsNorm.startsWith(`${entryCwd}/`) ||
            entryCwd.startsWith(`${wsNorm}/`);
      if (!match) continue;

      const projectKey = getProjectKey(entry.cwd);
      const transcriptPath = join(
        home,
        ".claude",
        "projects",
        projectKey,
        `${entry.sessionId}.jsonl`
      );
      let mtime = entry.startedAt;
      try {
        mtime = statSync(transcriptPath).mtimeMs;
      } catch {
        // startedAt fallback when the transcript file is missing
      }

      const tail = readTail(transcriptPath);
      const turnState = tail ? classifyLastEntry(tail) : "unknown";

      candidates.push({ entry, transcriptPath, mtime, turnState });
    } catch {
      continue;
    }
  }

  return candidates;
}

/** Pick the most-deserving workspace candidate. Tiered ranking:
 *
 *   1. Hot recency. A candidate written within HOT_RECENCY_MS
 *      outranks every candidate outside that window. The strongest
 *      "user is here right now" signal the file system gives us, so
 *      a sibling whose mid-turn classification is older than the
 *      hot window cannot steal focus from a session the user just
 *      touched.
 *   2. Activity score. Inside the same hot bucket, prefer
 *      `assistant-pending` over `user` over `assistant-done`.
 *      Activity score is gated by ACTIVITY_FRESHNESS_MS so an
 *      orphaned mid-turn tail from days ago cannot outrank a fresh
 *      idle session.
 *   3. mtime. Most-recent-write wins.
 *   4. Entrypoint tiebreaker. `claude-vscode` beats other
 *      entrypoints when all of the above are equal.
 *
 * Without the hot bucket, an idle background session classified
 * `assistant-pending` (the user left it mid-turn earlier) could
 * outrank a sibling the user is actively typing in right now,
 * because the activity score (3) beats the typed session's `user`
 * score (2) for as long as both sit inside the 5-minute activity
 * window. Hot recency promotes the just-touched session above that
 * comparison. */
export function rankActiveSession(
  candidates: readonly SessionCandidate[]
): SessionEntry | null {
  if (candidates.length === 0) return null;

  interface RankedCandidate {
    entry: SessionEntry;
    mtime: number;
    activity: number;
    isHot: boolean;
  }
  const now = Date.now();
  const ranked: RankedCandidate[] = candidates.map((c) => {
    const rawActivity = ACTIVITY_SCORE[c.turnState] ?? 0;
    const fresh = now - c.mtime <= ACTIVITY_FRESHNESS_MS;
    const activity = fresh ? rawActivity : 0;
    const isHot = now - c.mtime <= HOT_RECENCY_MS;
    return { entry: c.entry, mtime: c.mtime, activity, isHot };
  });

  let best = ranked[0];
  for (let i = 1; i < ranked.length; i++) {
    const c = ranked[i];
    const beats =
      (c.isHot && !best.isHot) ||
      (c.isHot === best.isHot &&
        (c.activity > best.activity ||
          (c.activity === best.activity && c.mtime > best.mtime) ||
          (c.activity === best.activity &&
            c.mtime === best.mtime &&
            c.entry.entrypoint === "claude-vscode" &&
            best.entry.entrypoint !== "claude-vscode")));
    if (beats) best = c;
  }
  return best.entry;
}

/** Tally workspace inventory from the walker result. `total` counts
 * every live process file whose cwd matches the workspace (no
 * freshness gate - presence of the process file IS Claude's "open"
 * signal, since the CLI removes the file on exit). `inProgress` is
 * the subset whose transcript tail classifies as `user` or
 * `assistant-pending`. Drives the multi-session tooltip line. */
export function tallyWorkspaceSessions(
  candidates: readonly SessionCandidate[]
): { total: number; inProgress: number } {
  let total = 0;
  let inProgress = 0;
  for (const c of candidates) {
    total++;
    if (c.turnState === "user" || c.turnState === "assistant-pending") {
      inProgress++;
    }
  }
  return { total, inProgress };
}

/**
 * Scan the workspace's Claude projects directory for the most
 * recently modified transcript. Used as a fallback when no live CLI
 * process matches the workspace. Project directory is resolved
 * case-insensitively to tolerate drive-letter case drift.
 *
 * Two-stage lookup:
 *   1. Try the workspace-specific project dir first. This is the
 *      common case: user opens VS Code in a folder where they have
 *      run Claude Code before, and we want their most recent
 *      transcript for THIS workspace.
 *   2. If that returns nothing AND the workspace path is empty
 *      (folderless VS Code window), fall back to scanning every
 *      project dir under ~/.claude/projects and return the globally-
 *      newest .jsonl. This mirrors how Codex handles a folderless
 *      window - it refuses to go blank when SOME session data is
 *      available.
 *
 *      The global fallback is GATED on `workspacePath === ""` because
 *      firing it when a workspace folder IS open is what produced
 *      cross-workspace contamination. Pre-fix: if Stage 1 missed (the
 *      workspace's project dir was named differently due to encoding
 *      drift, was empty, or didn't exist yet), Stage 2 returned the
 *      globally-newest transcript across ALL workspaces - so an
 *      actively-typing session in workspace A bled its mtime updates
 *      and turn-state onto workspace B's widget. Post-fix: a workspace
 *      with no transcripts yet stays in `waiting`/`no-session` instead
 *      of borrowing another workspace's activity.
 */
export function findLastKnownTranscript(
  workspacePath: string
): LastKnownTranscript | null {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return null;

  const workspaceBest = findNewestJsonlInWorkspaceDir(
    projectsDir,
    workspacePath
  );
  if (workspaceBest) return workspaceBest;

  // Only fall through to the global scan when there's genuinely no
  // workspace folder to disambiguate against. With a folder open,
  // returning some-other-workspace's transcript is cross-pollination,
  // not a helpful fallback.
  if (workspacePath !== "") return null;
  return findNewestJsonlAcrossAllProjects(projectsDir);
}

/** Stage 1: case-insensitive lookup of the workspace's project dir,
 * then newest .jsonl inside it. Returns null if the workspace path
 * is empty, the project dir does not exist, or the dir is empty. */
function findNewestJsonlInWorkspaceDir(
  projectsDir: string,
  workspacePath: string
): LastKnownTranscript | null {
  if (!workspacePath) return null;
  const projectKey = getProjectKey(workspacePath);
  if (!projectKey) return null;

  let matchedDir: string | null = null;
  try {
    const entries = readdirSync(projectsDir);
    const targetLower = projectKey.toLowerCase();
    for (const e of entries) {
      if (e.toLowerCase() === targetLower) {
        matchedDir = join(projectsDir, e);
        break;
      }
    }
  } catch {
    return null;
  }
  if (!matchedDir) return null;

  return findNewestJsonlInDir(matchedDir);
}

/** Stage 2: sweep every project dir under ~/.claude/projects and
 * return the globally-newest .jsonl. Used when the workspace-specific
 * lookup has nothing to show. */
function findNewestJsonlAcrossAllProjects(
  projectsDir: string
): LastKnownTranscript | null {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return null;
  }

  let best: LastKnownTranscript | null = null;
  for (const d of dirs) {
    const full = join(projectsDir, d);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const candidate = findNewestJsonlInDir(full);
    if (candidate && (!best || candidate.mtime > best.mtime)) {
      best = candidate;
    }
  }
  return best;
}

/** Helper: newest .jsonl in a single dir, or null if none. The
 * originating `cwd` is read out of the chosen file's first line so
 * the widget can label cross-project fallback transcripts with their
 * real project basename, not the current workspace's. */
function findNewestJsonlInDir(dir: string): LastKnownTranscript | null {
  let bestPath: string | null = null;
  let bestMtime = 0;
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const fullPath = join(dir, file);
      try {
        const mtime = statSync(fullPath).mtimeMs;
        if (mtime > bestMtime) {
          bestPath = fullPath;
          bestMtime = mtime;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  if (!bestPath) return null;
  return {
    sessionId: basename(bestPath, ".jsonl"),
    path: bestPath,
    mtime: bestMtime,
    cwd: parseCwd(bestPath),
  };
}
