import type { StatusBarWidget as GenericStatusBarWidget } from "../engine/serviceTypes";
import type { StageInfo } from "../shared/codex-rollout/types";
import type { CompactFlashSnapshot } from "../shared/polling/compactFlashMachine";
import type { LastEntryKind } from "../shared/transcriptClassifier";

/** Entry from ~/.codex/session_index.jsonl */
export interface CodexSessionIndex {
  id: string;
  thread_name: string;
  updated_at: string;
}

/** Resolved session data for display */
export interface CodexResolvedSession {
  sessionId: string;
  label: string; // folder name from cwd
  sessionTitle: string; // thread_name or first user message
  modelSlug: string; // e.g. "gpt-5.1-mini"
  contextUsed: number; // last_token_usage.total_tokens (matches Codex native hover)
  contextWindowSize: number; // effective model context window from token_count
  autoCompactTokens: number; // effective context window ceiling (matches Codex native hover); actual compact trigger is ~90/95 of this
  lastActiveAt: number; // ms - rollout file mtime (display metadata only)
  /** Extension-observed growth timestamp (ms). Set to wall-clock
   * `Date.now()` on every poll where the rollout file's byte size
   * grew; seeded with the kernel mtime when a new rollout is first
   * picked up so a stale file does not falsely read as "just active".
   *
   * Drives the active-indicator freshness gate in place of the kernel
   * mtime because the Codex TUI keeps its rollout file open for the
   * lifetime of the session, and Windows NTFS lazily flushes mtime
   * on an open handle - the file's size grows on every append, but
   * `st.mtimeMs` can lag by tens of seconds. With the 30s freshness
   * window driven directly off mtime, the comment-discussion cycle
   * collapses to idle mid-turn even while Codex is actively writing.
   * Sampling growth at the syscall layer makes the freshness gate
   * independent of the kernel's mtime cadence. */
  lastActivityObservedAt: number;
  /** Last rollout event classification. Drives the active-state
   * indicator. `user` and `assistant-pending` mean a response is in
   * flight; `assistant-done` and `unknown` are idle. */
  turnState: LastEntryKind;
  /** Stage + tool + plan snapshot parsed from the same tail read
   * that populated `turnState`. Drives the active-state tooltip
   * richness (current tool name, plan progress, reasoning vs output
   * split, cache hit rate). Parser is shared with the Epic Handshake
   * dispatcher. */
  stageInfo: StageInfo;
  /** Timestamp (ms) of the most recent `compacted` / `context_compacted`
   * rollout entry. Drives compact-aware banner classification: the
   * widget fires a yellow LOAD banner once per new compact observation,
   * signaling a deliberate context rebuild. Null when no compact event
   * is in the scanned tail window. */
  lastCompactTimestamp: number | null;
  /** Smoothed tokens-per-second from the most recent rollout delta.
   * `TpsTracker` over cumulative `usage.tokens` (which Codex updates on
   * every mid-turn `token_count` event) against rollout mtime as the
   * time axis. Null when no recent positive sample is available (idle,
   * no turn yet, file not advancing). Decays after ~30s of no growth so
   * a pause does not keep showing a stale reading. */
  tokensPerSecond: number | null;
  /** Compact-completion flash snapshot. When `state` is
   * `"flashing-completion"` the widget replaces the token text with a
   * saturated orange 100% bar for the flash window. Codex's `compacted`
   * rollout entry is the post-completion boundary (no live progress is
   * observable, same as Claude). Driven by the shared
   * `CompactFlashMachine`. */
  compactState: CompactFlashSnapshot;
  /** Snapshot of how many Codex sessions in this workspace are
   * currently open and how many of those have an in-flight turn.
   * `total` counts rollouts whose cwd matches the workspace and
   * whose mtime is within the inventory window (Codex rollouts
   * persist on disk after the CLI exits, so a freshness gate is
   * what defines "open" - distinct from Claude's process-file
   * signal). `inProgress` is the subset whose tail classifies as
   * `assistant-pending` or `user`. Drives the multi-session tooltip
   * line that surfaces when N > 1. Always present - 1/0 in the
   * single-session case. Computed alongside the active-rollout
   * pick so no extra walk is required. */
  workspaceSessionInventory: { total: number; inProgress: number };
}

export type CodexTokenWidgetState =
  | { status: "not-installed" } // ~/.codex/ does not exist - hide widget
  | { status: "no-session" }
  | { status: "waiting" }
  | { status: "ok"; session: CodexResolvedSession };

/** Codex session token widget contract. */
export type StatusBarWidget = GenericStatusBarWidget<CodexTokenWidgetState>;
