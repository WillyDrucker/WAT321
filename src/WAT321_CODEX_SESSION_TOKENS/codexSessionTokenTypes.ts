import type { StageInfo } from "../shared/codexRollout/turnStageTypes";
import type { CompactFlashSnapshot } from "../shared/polling/compactFlashMachine";
import type { LastEntryKind } from "../shared/turnState";

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
  modelSlug: string; // the model slug the rollout records
  effort: string | null; // effort of the latest turn_context, null before the first turn
  contextUsed: number; // last_token_usage.total_tokens (matches Codex native hover)
  contextWindowSize: number; // effective model context window from token_count
  /** The usable window Codex's own hover shows, the widget's
   * denominator. */
  ceilingTokens: number;
  /** Where auto-compact fires, ahead of the ceiling. Drives the
   * "Auto-Compact at ~X" tooltip line. */
  autoCompactEffectiveTokens: number;
  /** When the rollout last grew, in ms: wall clock on each poll that
   * sees its byte size grow, seeded with its mtime when the rollout is
   * first picked up. Codex holds the file open for the whole session
   * and Windows flushes mtime late on an open handle, so the raw mtime
   * can trail a live turn by tens of seconds. */
  lastActiveAt: number;
  /** Last rollout event classification (see `LastEntryKind`), which
   * drives the active-state indicator. */
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
  /** Tokens per second from `TpsTracker` over cumulative `usage.tokens`,
   * timed by rollout mtime and cleared after an idle gap so a pause
   * never shows a stale reading. Null until the first positive sample. */
  tokensPerSecond: number | null;
  /** Compact-completion flash snapshot from the shared
   * `CompactFlashMachine`. Codex's `compacted` rollout entry is the
   * post-completion boundary, so no live progress is observable, the
   * same as on Claude. Always present so the widget never null-checks. */
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
