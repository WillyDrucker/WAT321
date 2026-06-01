import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readTail } from "../shared/fs/fileReaders";
import { getProjectKey, normalizePath } from "../shared/fs/pathUtils";
import {
  classifyLastEntry,
  type LastEntryKind,
} from "../shared/transcriptClassifier";
import type { SessionEntry } from "./types";

/**
 * Live-session discovery for Claude. `walkWorkspaceSessions` does the
 * `~/.claude/sessions/*.json` I/O once per poll; `rankActiveSession`
 * and `tallyWorkspaceSessions` are pure consumers over that result.
 *
 * The lastKnown fallback (`findLastKnownTranscript`) lives in
 * `lastKnownTranscriptScan.ts` and is re-exported from this file so
 * the service keeps a single import surface.
 */

export {
  findLastKnownTranscript,
  type LastKnownTranscript,
} from "./lastKnownTranscriptScan";

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
        // startedAt fallback when transcript file is missing
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
 *   1. Selected session memento. When `selectedSessionId` matches a
 *      candidate's session id, that candidate wins outright. This is
 *      the user's actual click in the Claude Code sidebar switcher,
 *      read from VS Code's per-workspace `state.vscdb`. It outranks
 *      every disk signal because no disk signal can disambiguate two
 *      concurrently-active sessions (both pass freshness, both
 *      classify pending, both stay inside the hot window) - their
 *      mtimes alternate with every tool-call write and the widget
 *      flips. The memento sticks while disk activity churns.
 *   2. Hot recency. A candidate written within HOT_RECENCY_MS
 *      outranks every candidate outside that window. The strongest
 *      "user is here right now" signal the file system gives us, so
 *      a sibling whose mid-turn classification is older than the
 *      hot window cannot steal focus from a session the user just
 *      touched.
 *   3. Activity score. Inside the same hot bucket, prefer
 *      `assistant-pending` over `user` over `assistant-done`.
 *      Activity score is gated by ACTIVITY_FRESHNESS_MS so an
 *      orphaned mid-turn tail from days ago cannot outrank a fresh
 *      idle session.
 *   4. mtime. Most-recent-write wins.
 *   5. Entrypoint tiebreaker. `claude-vscode` beats other
 *      entrypoints when all of the above are equal.
 *
 * `selectedSessionId` falls through cleanly when null, when the
 * memento file is unavailable (older VS Code Electron without
 * `node:sqlite`, brand-new workspace with no Claude session yet
 * selected), or when the memento points at a session not in the
 * walker output. */
export function rankActiveSession(
  candidates: readonly SessionCandidate[],
  selectedSessionId: string | null = null
): SessionEntry | null {
  if (candidates.length === 0) return null;

  if (selectedSessionId) {
    const direct = candidates.find(
      (c) => c.entry.sessionId === selectedSessionId
    );
    if (direct) return direct.entry;
  }

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
