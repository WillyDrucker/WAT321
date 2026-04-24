import type { StatusBarWidget as GenericStatusBarWidget } from "../shared/serviceTypes";
import type { LastEntryKind } from "../shared/transcriptClassifier";
import type { ClaudeTurnInfo } from "./parsers";

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
  contextUsed: number; // tokens currently in context
  contextWindowSize: number; // 200k or 1M
  autoCompactPct: number; // e.g. 70
  /** Real compaction fire point in tokens. Distinct from
   * `autoCompactPct * contextWindowSize` because recent Claude Code
   * releases stack a small reserve on the override rather than
   * replacing the default formula. Widget uses the nominal product
   * for the bar + "N/M" numerator (that's the user's target); this
   * effective value drives the "Auto-Compact at ~X" label so the
   * advertised fire point matches observed behavior. */
  autoCompactEffectiveTokens: number;
  source: "live" | "lastKnown"; // live = CLI process active, lastKnown = fallback from transcript mtime
  lastActiveAt: number; // ms - live: Date.now(); lastKnown: transcript file mtime
  /** Last transcript entry classification. Drives the active-state
   * indicator. `user` and `assistant-pending` mean a response is in
   * flight; `assistant-done` and `unknown` are idle. Interrupts are
   * mapped to `assistant-done` by the classifier so the widget
   * returns to idle immediately. */
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
}

export type WidgetState =
  | { status: "not-installed" } // ~/.claude/ does not exist - hide widget
  | { status: "no-session" }
  | { status: "waiting" } // session exists but no usage data yet
  | { status: "ok"; session: ResolvedSession };

/** Claude session token widget contract. */
export type StatusBarWidget = GenericStatusBarWidget<WidgetState>;
