/**
 * Sentinel written to `~/.wat321/claude-force-auto-compact-sentinel.json`
 * while the experimental Force Claude Auto-Compact setting is armed.
 * Serves as both the in-flight marker and the self-heal record if VS
 * Code crashes between arm and restore.
 */
export interface ExperimentalAutoCompactSentinel {
  /** Version number for forward compatibility. */
  version: 1;
  /** Absolute path to ~/.claude/settings.json we edited. */
  settingsPath: string;
  /** Original CLAUDE_AUTOCOMPACT_PCT_OVERRIDE value (string form). */
  originalOverride: string | null;
  /** Value we set it to (always "1"). */
  armedOverride: string;
  /** Transcript file path we are watching for the compact-fired signal. */
  watchTranscriptPath: string;
  /** Baseline file size at arm time. */
  baselineSize: number;
  /** ms timestamp when we armed. */
  armedAt: number;
}
