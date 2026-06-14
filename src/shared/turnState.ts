/**
 * Shared turn-state vocabulary for session-token transcripts. Both
 * providers' classifiers (CLAUDE_SESSION_TOKENS/turnClassifier.ts and
 * CODEX_SESSION_TOKENS/turnClassifier.ts) produce this type, and the
 * widget render path plus the discovery walkers consume it. It lives
 * here, apart from the provider classifiers, because the type is the
 * one piece they all share.
 */

/** Classification of the last parseable JSONL entry in a transcript
 * tail. */
export type LastEntryKind =
  /** Last entry is a user message (prompt or tool_result). The model
   * is about to respond. */
  | "user"
  /** Last entry is an assistant message containing an unresolved
   * `tool_use` block. The model is waiting on tool execution. */
  | "assistant-pending"
  /** Last entry is an assistant text-only message. Turn complete - a
   * real model response landed. The canonical notification-eligible
   * state (provider gates may also fire on `unknown` as a fail-safe). */
  | "assistant-done"
  /** Last entry is the auto-compact summary marker. Structurally a
   * user-type entry, semantically the terminal state of an internal
   * compaction event (the model is about to resume the same task on
   * a fresh context window). The widget treats it as idle (same as
   * assistant-done) so the thinking indicator stops spinning, but the
   * toast notifier suppresses it - the user's task is not actually
   * complete, the engine just rotated context behind the scenes. */
  | "compact-end"
  /** Last entry is the user-interrupt marker (Esc / Ctrl+C). The
   * widget treats it as idle so the thinking indicator stops, and the
   * toast notifier suppresses it because the user explicitly aborted
   * and a "Claude finished" toast would misrepresent that. */
  | "interrupted"
  /** Could not classify (empty tail, unparseable, unknown type).
   * Treated as "idle" by callers so a broken scanner never blocks
   * permanently. */
  | "unknown";
