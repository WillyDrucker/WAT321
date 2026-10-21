/**
 * Path identity for workspace matching. `normalizePath` folds case on
 * every platform because the widgets' workspace match is best-effort
 * and a case-only mismatch between a CLI cwd and the VS Code folder
 * must not hide a live session. `samePath` folds case only on Windows
 * because it gates destructive deletes.
 */

/** Backslashes to forward slashes, trailing slash stripped, lowercased. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

/** True when `cwd` is the workspace folder, a folder inside it, or a
 * folder above it. A workspace opened at `c:\Dev\WAT321` must adopt a
 * CLI launched from `c:\Dev\WAT321\src`, and the reverse: VS Code open
 * on the subfolder, CLI launched at the root. An empty workspace path
 * matches everything. */
export function isSameWorkspaceTree(workspacePath: string, cwd: string): boolean {
  const ws = normalizePath(workspacePath);
  if (ws === "") return true;
  const c = normalizePath(cwd);
  return c === ws || ws.startsWith(`${c}/`) || c.startsWith(`${ws}/`);
}

/** True when two paths name the same folder: separators and a trailing
 * slash are ignored, and case only on Windows. This gate proves a
 * rollout's ownership before a delete, so two Linux folders that
 * differ by case must not match. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

/**
 * The project key Claude Code uses for a workspace's transcript folder
 * under `~/.claude/projects/`. Cross-platform:
 *   "c:\Code\my-project"          -> "c--Code-my-project"
 *   "c:\Dev\321_STD"              -> "c--Dev-321-STD"
 *   "/srv/code/my-project"        -> "srv-code-my-project"
 *   "/var/lib/my-project"         -> "var-lib-my-project"
 * Backslashes normalize to forward slashes, the leading slash strips,
 * then slashes, drive-letter colons, AND underscores collapse to
 * dashes. The underscore rule mirrors Claude Code's own encoding: a
 * workspace at `c:\Dev\321_STD` writes to `c--Dev-321-STD/`. Without
 * it the live-session lookup misses the folder and the widget falls
 * back to another workspace's newest transcript.
 */
export function getProjectKey(cwd: string): string {
  return cwd
    .replace(/\\/g, "/")
    .replace(/^\//, "")
    .replace(/\//g, "-")
    .replace(/:/g, "-")
    .replace(/_/g, "-");
}
