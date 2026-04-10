/**
 * Normalize a filesystem path for cross-platform comparison:
 * backslashes to forward slashes, strip trailing slash, lowercase.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

/**
 * Convert a cwd to the project key used by Claude Code for transcript paths.
 * e.g. "c:\Dev\WAT321" -> "c--Dev-WAT321"
 */
export function getProjectKey(cwd: string): string {
  return cwd
    .replace(/\\/g, "/")
    .replace(/^\//, "")
    .replace(/\//g, "-")
    .replace(/:/g, "-");
}
