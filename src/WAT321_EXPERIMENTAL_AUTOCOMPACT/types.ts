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

/** Live context info about the active Claude session, consumed by the
 * preflight gate so it can refuse arming when the session is too
 * fresh, mid-turn, or recently compacted. Built from the Claude
 * session token service's `ok` state inside the experimental
 * service's listener. */
export interface ActiveContextInfo {
  /** Absolute path to the transcript `.jsonl` file we would watch
   * for the compact marker. Also used to read the tail for
   * `claude-busy` and `recent-compact` detection. */
  transcriptPath: string;
  /** Current context token count. */
  contextUsed: number;
  /** Token ceiling at which Claude's native auto-compact fires
   * (e.g. `autoCompactPct * contextWindowSize / 100`). */
  ceiling: number;
  /** `contextUsed / ceiling` for the `below-threshold` gate. */
  fraction: number;
}

/** Reasons the preflight gate may refuse an arm request. Each maps
 * to a user-facing error toast via `formatArmBlockerMessage`. */
export type ArmBlocker =
  | "no-live-session"
  | "claude-busy"
  | "below-threshold"
  | "recent-compact"
  | "cooldown"
  | "settings-stuck"
  | "settings-io-error";
