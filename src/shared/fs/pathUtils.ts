/**
 * Normalize a filesystem path for cross-platform comparison:
 * backslashes to forward slashes, strip trailing slash, lowercase.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

/**
 * Convert a cwd to the project key used by Claude Code for transcript paths.
 * Cross-platform - same shape works for Windows, macOS, and Linux:
 *   "c:\Code\my-project"          -> "c--Code-my-project"
 *   "c:\Dev\321_STD"              -> "c--Dev-321-STD"
 *   "/Users/foo/code/my-project"  -> "Users-foo-code-my-project"
 *   "/home/foo/my-project"        -> "home-foo-my-project"
 * Backslashes normalize to forward slashes, leading slash strips, then
 * remaining slashes, drive-letter colons, AND underscores collapse to
 * dashes. The underscore rule mirrors Claude Code's filesystem encoding
 * (verified empirically on v2.1.143): a workspace at `c:\Dev\321_STD`
 * writes its transcripts to `~/.claude/projects/c--Dev-321-STD/`, not
 * `c--Dev-321_STD/`. Without underscore normalization, getProjectKey
 * produced the wrong directory name, the live-session existsSync check
 * fell through to lastKnown fallback, and the global-newest fallback
 * cross-pollinated activity from another workspace's transcript onto
 * this workspace's widget.
 */
export function getProjectKey(cwd: string): string {
  return cwd
    .replace(/\\/g, "/")
    .replace(/^\//, "")
    .replace(/\//g, "-")
    .replace(/:/g, "-")
    .replace(/_/g, "-");
}
