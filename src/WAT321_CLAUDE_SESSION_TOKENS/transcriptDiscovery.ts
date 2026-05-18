import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionEntry } from "./types";
import { getProjectKey, normalizePath } from "../shared/fs/pathUtils";
import { parseCwd } from "./parsers";

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
  /** The cwd the transcript was originally recorded in, parsed from
   * the first line of the file. Used as the widget label so that a
   * cross-project fallback (transcript belongs to a different
   * workspace than the one VS Code is currently open in) shows the
   * actual project's basename instead of the wrong one. Empty when
   * the transcript could not be read or had no `cwd` field. */
  cwd: string;
}

/**
 * Pick the active Claude session for the given workspace path. Matches
 * on `cwd` bidirectionally: the workspace can sit inside the session's
 * cwd (claude launched at a project root, VS Code opened deeper) OR
 * the session's cwd can sit inside the workspace (claude launched from
 * a subdirectory, VS Code opened at the project root). Ties break by
 * transcript mtime so a resumed session beats its stale sibling, with
 * `entrypoint: "claude-vscode"` winning over terminal-launched sessions
 * as the final tiebreaker when mtimes are equal.
 *
 * Bidirectional match closes a recurring widget-misses-the-live-session
 * gap: when a user launches `claude` from `c:\Dev\WAT321\subdir` but
 * has VS Code open at `c:\Dev\WAT321`, the unidirectional check
 * `workspace ⊆ session.cwd` fails (workspace is the ancestor, not the
 * descendant), live PID is never found, and the widget drops to mtime-
 * only fallback. The reverse check `session.cwd ⊆ workspace` recovers
 * the PID in that case.
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
