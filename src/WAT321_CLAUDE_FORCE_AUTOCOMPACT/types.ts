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

/** Reasons the widget may enter the grayed `unavailable` state. Each
 * has its own tooltip and clears differently - some automatically as
 * context grows back, others require the user to run the reset
 * command. Widgets render all of them in the same muted color so
 * the user reads the tooltip to learn which applies; RED remains
 * reserved for the armed state to prevent visual confusion.
 *
 * The primary gate is `below-useful-threshold`: the user's current
 * context must be at least `USEFUL_CONTEXT_FRACTION` (20%) of the
 * auto-compact ceiling before arming makes sense. Below that there
 * is nothing meaningful to compact. This single check subsumes the
 * old `recent-native-compact` and `post-disarm-cooldown` gates
 * because in both of those cases the user is always in the
 * low-context post-compact zone.
 *
 * `loop-suspected` stays as a secondary defense: in the tiny
 * edge-case where a small-ceiling user's post-compact state lands
 * above the 20% gate, the loop detection backstops the context
 * gate and prevents a second consecutive arm. */
export type UnavailableReason =
  | "below-useful-threshold"
  | "claude-busy"
  | "loop-suspected"
  | "settings-stuck-at-armed"
  | "settings-missing"
  | "settings-io-error"
  | "sentinel-exists-external";

export type ClaudeForceAutoCompactState =
  | { status: "not-installed" } // Claude CLI not installed or enableClaudeForceAutoCompact false
  | { status: "ready" }
  | { status: "armed"; sentinel: ClaudeForceAutoCompactSentinel }
  | { status: "restored" } // briefly after successful restore, auto-returns to "ready"
  | { status: "stale-sentinel"; sentinel: ClaudeForceAutoCompactSentinel } // found on startup, restore failed
  | { status: "unavailable"; reason: UnavailableReason }; // widget grayed, not clickable, tooltip explains

export type StatusBarWidget = GenericStatusBarWidget<ClaudeForceAutoCompactState>;

/** Why an armed session was disarmed. Surfaced to the widget so
 * the user sees a notification explaining an unexpected restore. */
export type DisarmReason =
  | "user-cancel"
  | "compact-detected"
  | "timeout"
  | "session-ended"
  | "session-switched";

/** What the widget knows about the current Claude session it is
 * tracking. Lives here (not in widget.ts) so other modules that
 * need to understand session descriptors can import it without
 * reaching into the widget file. */
export interface ClaudeSessionDescriptor {
  sessionId: string;
  label: string;
  sessionTitle: string;
  contextUsed: number;
  contextWindowSize: number;
  autoCompactPct: number;
  source: "live" | "lastKnown";
}
