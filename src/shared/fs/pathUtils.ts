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
 *   "/Users/foo/code/my-project"  -> "Users-foo-code-my-project"
 *   "/home/foo/my-project"        -> "home-foo-my-project"
 * Backslashes normalize to forward slashes, leading slash strips, then
 * remaining slashes and any drive-letter colon collapse to dashes.
 */
export function getProjectKey(cwd: string): string {
  return cwd
    .replace(/\\/g, "/")
    .replace(/^\//, "")
    .replace(/\//g, "-")
    .replace(/:/g, "-");
}
