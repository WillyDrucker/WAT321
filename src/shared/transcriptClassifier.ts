/**
 * Classifier for the last parseable entry in a Claude transcript tail.
 * Consumed by the notification bridge in bootstrap.ts for turn-
 * completion gating AND by the session token widget's thinking
 * indicator. The two consumers want different shapes from the same
 * tail, so the classifier distinguishes:
 *
 *   - `assistant-done`    - real model response complete (fires toast)
 *   - `assistant-pending` - tool_use mid-turn (active, no toast)
 *   - `user`              - prompt or tool_result waiting on the model
 *   - `compact-end`       - auto-compact summary entry (idle, no toast)
 *   - `interrupted`       - Esc / Ctrl+C abort (idle, no toast)
 *   - `unknown`           - unparseable / empty (idle, suppress)
 *
 * `compact-end` and `interrupted` are idle for the widget but remain
 * distinct from `assistant-done` so completion toasts only fire for
 * a real model response.
 *
 * Lives in shared/ rather than the Claude session token tool because
 * cross-tool concerns belong in shared infrastructure.
 */

/** Marker text Claude Code writes to the transcript when the user
 * interrupts a turn. Matched as a substring to tolerate minor
 * variations across Claude Code versions. */
const INTERRUPT_MARKER = "[Request interrupted";

/** Markers Claude Code writes to the transcript as the terminal entry
 * of an auto-compact operation. The compact summary arrives as a
 * `type: "user"` entry (structurally a new prompt) but meaning-wise
 * is the end state of the prior turn, not a pending question. Without
 * this recognition the session-token widget's thinking indicator stays
 * on after every auto-compact because the classifier returns `user`
 * and keeps waiting for an assistant response that never comes (the
 * real next assistant response only fires on the user's NEXT prompt).
 * Matched as substrings to tolerate wording drift across Claude Code
 * releases. */
const COMPACT_MARKERS = [
  "This session is being continued from a previous conversation",
  "conversation was compacted",
  "<command-name>compact</command-name>",
] as const;

/** True if a decoded text block contains any of our auto-compact
 * terminal markers. Used inside the user-entry classifier path. */
function isCompactMarker(text: string): boolean {
  for (const marker of COMPACT_MARKERS) {
    if (text.includes(marker)) return true;
  }
  return false;
}

/** Classification of the last parseable JSONL entry in a Claude
 * transcript tail. */
export type LastEntryKind =
  /** Last entry is a user message (prompt or tool_result). Claude
   * is about to respond. */
  | "user"
  /** Last entry is an assistant message containing an unresolved
   * `tool_use` block. Claude is waiting on tool execution. */
  | "assistant-pending"
  /** Last entry is an assistant text-only message. Turn complete - a
   * real model response landed. This is the only kind that should
   * fire a "response complete" toast. */
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
   * widget treats it as idle so the thinking indicator stops; the
   * toast notifier suppresses it because the user explicitly aborted
   * and a "Claude finished" toast would misrepresent that. */
  | "interrupted"
  /** Could not classify (empty tail, unparseable, unknown type).
   * Treated as "idle" by callers so a broken scanner never blocks
   * permanently. */
  | "unknown";

/** Walk a tail buffer backwards, parsing the last non-empty JSONL
 * line, and classify it. Returns `"unknown"` on any failure mode. */
export function classifyLastEntry(tail: string): LastEntryKind {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (!raw) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(raw);
    } catch {
      // Partial line (mid-write) or invalid JSON. Claude Code writes
      // full JSONL lines atomically so any mid-write partial is
      // always the very last line, never somewhere in the middle.
      continue;
    }

    if (entry.type === "user") {
      // Interrupt and auto-compact entries arrive structurally as
      // user-typed entries but semantically end the prior turn. Each
      // gets its own kind so the widget can stop animating while the
      // toast notifier still distinguishes "model finished" from
      // "user aborted" / "engine compacted."
      const msg = entry.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      const textBlobs: string[] = [];
      if (typeof content === "string") {
        textBlobs.push(content);
      } else if (Array.isArray(content)) {
        for (const p of content) {
          if (typeof p !== "object" || p === null) continue;
          const block = p as Record<string, unknown>;
          if (block.type === "text" && typeof block.text === "string") {
            textBlobs.push(block.text);
          }
        }
      }
      for (const text of textBlobs) {
        if (text.includes(INTERRUPT_MARKER)) return "interrupted";
        if (isCompactMarker(text)) return "compact-end";
      }
      return "user";
    }
    if (entry.type === "assistant") {
      const msg = entry.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      if (Array.isArray(content)) {
        const hasToolUse = content.some(
          (p) =>
            typeof p === "object" &&
            p !== null &&
            (p as Record<string, unknown>).type === "tool_use"
        );
        if (hasToolUse) return "assistant-pending";
      }
      return "assistant-done";
    }
    // Other entry types (system, summary, etc.) keep walking.
  }
  return "unknown";
}
