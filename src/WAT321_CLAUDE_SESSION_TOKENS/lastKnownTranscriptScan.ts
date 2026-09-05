import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getProjectKey } from "../engine/fs/pathIdentity";
import { parseCwd } from "./parsers";

/**
 * Last-known-transcript fallback scanner. Used by the Claude session
 * service when no live `~/.claude/sessions/*.json` process matches
 * the workspace - returns the most recently modified `.jsonl` under
 * `~/.claude/projects/` so the widget can keep showing a meaningful
 * value (token counts, label) instead of going blank.
 *
 * Two-stage lookup:
 *   1. Try the workspace-specific project dir first (the common case).
 *   2. ONLY if the workspace path is empty (folderless VS Code), fall
 *      through to the globally-newest .jsonl across every project dir.
 *
 * The global fallback is gated on `workspacePath === ""` to avoid
 * cross-workspace contamination: with a folder open, a Stage 1 miss
 * would let Stage 2 return another workspace's freshly active
 * transcript and the widget would show its tokens / label / turn state
 * under the wrong project. A workspace with no transcripts yet stays in
 * `waiting` / `no-session` instead of borrowing another's activity.
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
 * return the globally-newest .jsonl. Used only when the workspace path
 * is empty (folderless VS Code window). */
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

/** Newest .jsonl in a single dir, or null if none. The originating
 * `cwd` is read out of the chosen file's first line so the widget
 * can label cross-project fallback transcripts with their real
 * project basename, not the current workspace's. */
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
        // best-effort: skip files we can't stat
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
    cwd: parseCwd(bestPath) ?? "",
  };
}
