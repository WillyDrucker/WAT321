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
  contextUsed: number; // last_token_usage.input_tokens
  contextWindowSize: number; // model_context_window
}

export type CodexTokenWidgetState =
  | { status: "no-session" }
  | { status: "waiting" }
  | { status: "ok"; session: CodexResolvedSession };

export interface StatusBarWidget {
  update(state: CodexTokenWidgetState): void;
  dispose(): void;
}
