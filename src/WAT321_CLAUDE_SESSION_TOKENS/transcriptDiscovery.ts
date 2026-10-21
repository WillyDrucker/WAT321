import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readTail } from "../engine/fs/fileReaders";
import { getProjectKey, isSameWorkspaceTree } from "../engine/fs/pathIdentity";
import { CLAUDE_PROJECTS_DIR } from "../shared/providers/claude/claudeHome";
import { compareActivity, rankActivity } from "../shared/sessionTokens/activityRanking";
import type { LastEntryKind } from "../shared/turnState";
import { classifyClaudeTurn } from "./claudeTurnClassifier";
import type { SessionEntry } from "./claudeSessionTokenTypes";

/**
 * Live-session discovery for Claude. `walkWorkspaceSessions` does the
 * `~/.claude/sessions/*.json` I/O once per poll. `rankActiveSession`
 * and `tallyWorkspaceSessions` are pure consumers over that result.
 * The lastKnown fallback lives in `lastKnownTranscriptScan.ts`.
 */

/** Per-session snapshot surfaced by the walker. Carries every field
 * the rank and tally consumers need so neither has to re-read the
 * session file or the transcript tail. `turnState` is `"unknown"`
 * when the transcript could not be read, and `mtime` falls back to
 * `entry.startedAt` in the same case. */
export interface SessionCandidate {
  entry: SessionEntry;
  transcriptPath: string;
  mtime: number;
  turnState: LastEntryKind;
}

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

  const candidates: SessionCandidate[] = [];

  for (const file of files) {
    try {
      const entry: SessionEntry = JSON.parse(
        readFileSync(join(sessionsDir, file), "utf8")
      );
      if (!isSameWorkspaceTree(workspacePath, entry.cwd)) continue;

      const projectKey = getProjectKey(entry.cwd);
      const transcriptPath = join(
        CLAUDE_PROJECTS_DIR,
        projectKey,
        `${entry.sessionId}.jsonl`
      );
      let mtime = entry.startedAt;
      try {
        mtime = statSync(transcriptPath).mtimeMs;
      } catch {
        // startedAt fallback when transcript file is missing
      }

      const tail = readTail(transcriptPath);
      const turnState = tail ? classifyClaudeTurn(tail) : "unknown";

      candidates.push({ entry, transcriptPath, mtime, turnState });
    } catch {
      continue;
    }
  }

  return candidates;
}

/** Pick the most-deserving workspace candidate: the shared
 * hot-recency > activity > mtime ranking, with `claude-vscode`
 * winning a full tie so the editor's own session takes the widget
 * over a terminal twin. */
export function rankActiveSession(
  candidates: readonly SessionCandidate[]
): SessionEntry | null {
  if (candidates.length === 0) return null;
  const now = Date.now();
  const ranked = candidates.map((c) => ({
    entry: c.entry,
    rank: rankActivity(c.turnState, c.mtime, now),
  }));
  let best = ranked[0];
  for (let i = 1; i < ranked.length; i++) {
    const c = ranked[i];
    const cmp = compareActivity(c.rank, best.rank);
    const beats =
      cmp > 0 ||
      (cmp === 0 &&
        c.entry.entrypoint === "claude-vscode" &&
        best.entry.entrypoint !== "claude-vscode");
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
