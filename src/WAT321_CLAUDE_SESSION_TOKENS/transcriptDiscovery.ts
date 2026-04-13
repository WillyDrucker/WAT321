import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionEntry } from "./types";
import { getProjectKey, normalizePath } from "../shared/fs/pathUtils";

/**
 * Resolves which Claude transcript a workspace should display. Two
 * strategies:
 *   1. `findActiveSession` - scan `~/.claude/sessions/*.json` for a
 *      live CLI process that matches the workspace.
 *   2. `findLastKnownTranscript` - when no live process is found, fall
 *      back to the most recently modified `.jsonl` under the
 *      workspace's `~/.claude/projects/<projectKey>/` directory.
 */

export interface LastKnownTranscript {
  sessionId: string;
  path: string;
  mtime: number;
}

/**
 * Pick the active Claude session for the given workspace path. Matches
 * on `cwd` (workspace or ancestor), then breaks ties by transcript
 * mtime so a resumed session beats its stale sibling. As a final
 * tiebreaker, `entrypoint: "claude-vscode"` wins over terminal-launched
 * sessions when transcript mtimes are equal.
 */
export function findActiveSession(
  sessionsDir: string,
  workspacePath: string
): SessionEntry | null {
  if (!existsSync(sessionsDir)) return null;

  let files: string[];
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }

  const wsNorm = normalizePath(workspacePath);
  const home = homedir();

  let best: SessionEntry | null = null;
  let bestMtime = 0;

  for (const file of files) {
    try {
      const entry: SessionEntry = JSON.parse(
        readFileSync(join(sessionsDir, file), "utf8")
      );
      const entryCwd = normalizePath(entry.cwd);
      const match =
        wsNorm === ""
          ? true
          : entryCwd === wsNorm || wsNorm.startsWith(entryCwd + "/");
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
        // startedAt fallback
      }

      const beatsBest = !best || mtime > bestMtime;
      const tieBreak =
        best !== null &&
        mtime === bestMtime &&
        entry.entrypoint === "claude-vscode" &&
        best.entrypoint !== "claude-vscode";

      if (beatsBest || tieBreak) {
        best = entry;
        bestMtime = mtime;
      }
    } catch {
      continue;
    }
  }

  return best;
}

/**
 * Scan the workspace's Claude projects directory for the most
 * recently modified transcript. Used as a fallback when no live CLI
 * process matches the workspace. Project directory is resolved
 * case-insensitively to tolerate drive-letter case drift.
 */
export function findLastKnownTranscript(
  workspacePath: string
): LastKnownTranscript | null {
  const projectKey = getProjectKey(workspacePath);
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return null;

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

  let bestPath: string | null = null;
  let bestMtime = 0;
  try {
    const files = readdirSync(matchedDir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const fullPath = join(matchedDir, file);
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
  };
}
