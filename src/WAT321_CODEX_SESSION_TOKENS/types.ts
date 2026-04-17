import type { StatusBarWidget as GenericStatusBarWidget } from "../shared/serviceTypes";
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
  /** Last rollout event classification. Drives the active-state
   * indicator. `user` and `assistant-pending` mean a response is in
   * flight; `assistant-done` and `unknown` are idle. */
  turnState: LastEntryKind;
}

export type CodexTokenWidgetState =
  | { status: "not-installed" } // ~/.codex/ does not exist - hide widget
  | { status: "no-session" }
  | { status: "waiting" }
  | { status: "ok"; session: CodexResolvedSession };

/** Codex session token widget contract. */
export type StatusBarWidget = GenericStatusBarWidget<CodexTokenWidgetState>;
