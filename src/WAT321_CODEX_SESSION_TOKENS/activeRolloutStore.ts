import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { normalizePath } from "../shared/fs/pathUtils";
import { clientStateDir } from "../shared/wat321Paths";
import { parseCwd } from "./parsers";

/**
 * Persisted pointer to the Codex rollout this workspace was last
 * tracking, so a long-running session is re-adopted across a VS Code
 * reload instead of vanishing once its rollout file ages past the
 * discovery walk's day-window (`MAX_DAYS_TO_SCAN`). Codex appends to
 * one file in its CREATION-date directory for the whole session, so a
 * session kept open for weeks eventually drops out of the walk; the
 * pointer lets the next launch re-adopt it directly.
 *
 * Per-workspace (`clientStateDir`) so two windows never clobber each
 * other's pointer. Best-effort: persistence is an optimization for the
 * aged-session case, never a correctness dependency, so every write
 * swallows failure and every read re-validates before use.
 */

function storePath(): string {
  return join(clientStateDir(), "codex-active-rollout.json");
}

/** True when a rollout's recorded cwd belongs to this workspace.
 * Bidirectional, matching the discovery walk's own match so a seeded
 * pointer is judged the same way the walk would judge it. */
function matchesWorkspace(workspacePath: string, cwd: string): boolean {
  const wsNorm = normalizePath(workspacePath);
  const cwdNorm = normalizePath(cwd);
  return (
    wsNorm === "" ||
    cwdNorm === wsNorm ||
    wsNorm.startsWith(`${cwdNorm}/`) ||
    cwdNorm.startsWith(`${wsNorm}/`)
  );
}

/** Re-validated active rollout for this workspace, or null. Returns a
 * path only when the file still exists AND its recorded cwd still
 * matches this workspace, so a stale or foreign pointer is never
 * adopted on launch. */
export function readPersistedRollout(workspacePath: string): string | null {
  try {
    const raw = readFileSync(storePath(), "utf8");
    const path = (JSON.parse(raw) as { rolloutPath?: unknown }).rolloutPath;
    if (typeof path !== "string" || !existsSync(path)) return null;
    const cwd = parseCwd(path);
    if (!cwd || !matchesWorkspace(workspacePath, cwd)) return null;
    return path;
  } catch {
    return null;
  }
}

/** Persist the rollout the widget is now tracking. */
export function persistRollout(rolloutPath: string): void {
  try {
    mkdirSync(clientStateDir(), { recursive: true });
    writeFileAtomic(storePath(), JSON.stringify({ rolloutPath }));
  } catch {
    // best-effort; never block a poll on persistence failure
  }
}

/** Forget the persisted pointer (Reset WAT321). */
export function clearPersistedRollout(): void {
  try {
    mkdirSync(clientStateDir(), { recursive: true });
    writeFileAtomic(storePath(), JSON.stringify({ rolloutPath: null }));
  } catch {
    // best-effort
  }
}
