import type { CompactFlashSnapshot } from "../shared/polling/compactFlashMachine";
import type { LastEntryKind } from "../shared/turnState";
import type { ClaudeTurnInfo } from "../shared/ui/sessionTokens/sessionTokenTypes";

/** Active session entry from ~/.claude/sessions/<pid>.json */
export interface SessionEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  entrypoint: string;
}

export interface ResolvedSession {
  sessionId: string;
  label: string; // folder name
  sessionTitle: string; // first user message, truncated
  modelId: string; // e.g. "claude-opus-4-6"
  effort: string | null; // e.g. "xhigh", null when the transcript records none
  contextUsed: number; // tokens currently in context
  contextWindowSize: number; // 200k or 1M
  /** Real compaction fire point in tokens. Claude Code stacks a small
   * reserve on the auto-compact override rather than replacing the
   * default formula, so the widget's bar, percent, and "N/M" numerator
   * all measure against this value and the "Auto-Compact at ~X" label
   * matches the observed fire point. */
  autoCompactEffectiveTokens: number;
  source: "live" | "lastKnown"; // live = CLI process active, lastKnown = fallback from transcript mtime
  lastActiveAt: number; // ms, the transcript file mtime
  /** Last transcript entry classification. Drives the active-state
   * indicator. `user` and `assistant-pending` mean a response is in
   * flight. `assistant-done`, `interrupted`, `compact-end`, and
   * `unknown` are idle. The classifier gives an abort and a compaction
   * their own kinds rather than folding them into `assistant-done`, so
   * the widget can stop animating on both while the toast notifier
   * still fires only on a real model response.
   *
   * An assistant entry carrying only a thinking block classifies as
   * `assistant-pending`, not done: the model is still mid-turn and has
   * not said anything yet. */
  turnState: LastEntryKind;
  /** Claude Code CLI process id for live sessions. Consumed by the
   * widget's active indicator: PID alive extends animation through
   * long silent thinking periods (deep reasoning Opus TTFB, slow
   * tool calls). Undefined on lastKnown fallbacks - those rely on
   * the mtime backstop alone. */
  pid?: number;
  /** Tool names, tool call counter, thinking-block presence, and
   * cache-hit split from the most recent turn. Parsed on every poll
   * from the same tail read that populated `turnState`. Drives the
   * session-token tooltip richness during active turns. */
  turnInfo: ClaudeTurnInfo;
  /** Output tokens per second from `TpsTracker`: a rolling window over
   * successive transcript writes, cleared after an idle gap so a pause
   * never shows a stale reading. Null until the first positive sample. */
  tokensPerSecond: number | null;
  /** Compact-completion flash snapshot from the shared
   * `CompactFlashMachine`. While `state` is `"flashing-completion"`
   * the widget renders the saturated orange bar, and `"idle"` falls
   * through to the standard render path. Always present so the widget
   * never null-checks. */
  compactState: CompactFlashSnapshot;
  /** Snapshot of how many Claude sessions in this workspace are
   * currently open and how many of those have an in-flight turn.
   * `total` counts live `~/.claude/sessions/*.json` process files
   * whose cwd matches the workspace (presence of the process file
   * is Claude's natural "open" signal - it vanishes on CLI exit).
   * `inProgress` is the subset whose transcript tail classifies as
   * `user` or `assistant-pending`. Drives the multi-session tooltip
   * line that surfaces when N > 1. Always present - 1/0 in the
   * single-session case. */
  workspaceSessionInventory: { total: number; inProgress: number };
}

export type WidgetState =
  | { status: "not-installed" } // ~/.claude/ does not exist - hide widget
  | { status: "no-session" }
  | { status: "waiting" } // session exists but no usage data yet
  | { status: "ok"; session: ResolvedSession };
