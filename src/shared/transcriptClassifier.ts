/**
 * Classifier for the last parseable entry in a Claude transcript tail.
 * Consumed by the notification bridge in bootstrap.ts for
 * turn-completion gating.
 *
 * Lives in shared/ rather than the Claude session token tool because
 * cross-tool concerns belong in shared infrastructure.
 */

/** Classification of the last parseable JSONL entry in a Claude
 * transcript tail. */
export type LastEntryKind =
  /** Last entry is a user message (prompt or tool_result). Claude
   * is about to respond. */
  | "user"
  /** Last entry is an assistant message containing an unresolved
   * `tool_use` block. Claude is waiting on tool execution. */
  | "assistant-pending"
  /** Last entry is an assistant text-only message. Turn complete. */
  | "assistant-done"
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

    if (entry.type === "user") return "user";
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
