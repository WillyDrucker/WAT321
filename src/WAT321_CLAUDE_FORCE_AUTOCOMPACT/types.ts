import type { StatusBarWidget as GenericStatusBarWidget } from "../shared/types";

/**
 * Sentinel written to ~/.wat321/claude-force-auto-compact-sentinel.json while the
 * tool is armed. Serves as both the in-flight marker and the self-heal
 * record if the extension crashes between arm and disarm.
 */
export interface ClaudeForceAutoCompactSentinel {
  /** Version number for forward compatibility. */
  version: 1;
  /** Absolute path to ~/.claude/settings.json we edited. */
  settingsPath: string;
  /** Original CLAUDE_AUTOCOMPACT_PCT_OVERRIDE value (string form). */
  originalOverride: string | null;
  /** Value we set it to (e.g. "1"). */
  armedOverride: string;
  /** Transcript file path we are watching for the compact-fired signal. */
  watchTranscriptPath: string;
  /** Baseline file size at arm time. */
  baselineSize: number;
  /** ms timestamp when we armed. */
  armedAt: number;
  /** Session ID of the target session (for display). */
  targetSessionId: string;
}

export type ClaudeForceAutoCompactState =
  | { status: "not-installed" } // Claude CLI not installed or enableClaudeForceAutoCompact false
  | { status: "ready" }
  | { status: "armed"; sentinel: ClaudeForceAutoCompactSentinel }
  | { status: "restored" } // briefly after successful restore, auto-returns to "ready"
  | { status: "stale-sentinel"; sentinel: ClaudeForceAutoCompactSentinel }; // found on startup, restore failed

export type StatusBarWidget = GenericStatusBarWidget<ClaudeForceAutoCompactState>;
