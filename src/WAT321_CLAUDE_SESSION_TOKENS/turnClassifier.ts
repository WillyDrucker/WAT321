import type { LastEntryKind } from "../shared/turnState";

/**
 * Turn-state classification for Claude transcript tails - the single
 * home for "what is the last turn doing" on the Claude side. Two
 * consumers read the same tail with different needs: classifyClaudeTurn
 * (drives the widget thinking indicator) and isClaudeTurnComplete (the
 * notification gate, which only fires on a real model response).
 */

/** Marker text Claude Code writes to the transcript when the user
 * interrupts a turn. Matched as a substring to tolerate minor
 * variations across Claude Code versions. */
const INTERRUPT_MARKER = "[Request interrupted";

/** Markers Claude Code writes to the transcript as the terminal entry
 * of a compact operation - both auto-compact (context-window exhaustion)
 * and manual (user types `/compact`). The compact summary arrives as a
 * `type: "user"` entry (structurally a new prompt) but meaning-wise
 * is the end state of the prior turn, not a pending question. Without
 * this recognition the session-token widget's thinking indicator stays
 * on after every compact because the classifier returns `user` and
 * keeps waiting for an assistant response that never comes (the real
 * next assistant response only fires on the user's NEXT prompt).
 *
 * Auto-compact lands as the "This session is being continued..." or
 * "conversation was compacted" user entry. Manual `/compact` lands as
 * `<command-name>/compact</command-name>` (with leading slash) followed
 * by `<local-command-stdout>Compacted </local-command-stdout>`. Matched
 * as substrings to tolerate wording drift across Claude Code releases. */
const COMPACT_MARKERS = [
  "This session is being continued from a previous conversation",
  "conversation was compacted",
  "<command-name>compact</command-name>",
  "<command-name>/compact</command-name>",
  "<local-command-stdout>Compacted",
] as const;

/** True if a decoded text block contains any of our auto-compact
 * terminal markers. Used inside the user-entry classifier path. */
function isCompactMarker(text: string): boolean {
  for (const marker of COMPACT_MARKERS) {
    if (text.includes(marker)) return true;
  }
  return false;
}

/** Walk a tail buffer backwards, parsing the last non-empty JSONL
 * line, and classify it. Returns `"unknown"` on any failure mode. */
export function classifyClaudeTurn(tail: string): LastEntryKind {
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
        let hasToolUse = false;
        let hasText = false;
        for (const p of content) {
          if (typeof p !== "object" || p === null) continue;
          const block = p as Record<string, unknown>;
          if (block.type === "tool_use") hasToolUse = true;
          if (
            block.type === "text" &&
            typeof block.text === "string" &&
            block.text.trim().length > 0
          ) {
            hasText = true;
          }
        }
        if (hasToolUse) return "assistant-pending";
        // Thinking-only entry: still mid-turn. Extended thinking lands
        // in the transcript as its own assistant entry seconds before
        // the text it precedes (2-11s observed). It carries no tool_use,
        // so treating "no tool_use" as done fired a toast right there -
        // and `parseLastAssistantText` skips entries with no text, so it
        // walked back and returned the PREVIOUS turn's response. The
        // user got a toast announcing the last turn's message as this
        // one's, then a second toast when the real text landed. No text
        // and no tool call means the model has not said anything yet.
        if (!hasText) return "assistant-pending";
      }
      return "assistant-done";
    }
    // Other entry types (system, summary, etc.) keep walking.
  }
  return "unknown";
}

/** Claude turn-completion gate for notifications. Only `assistant-done`
 * fires a toast. The classifier deliberately distinguishes:
 *   - `assistant-pending` (tool_use in flight) - mid-turn, suppress
 *   - `compact-end` (auto-compact summary marker) - engine rotated
 *     context behind the scenes, the user's task isn't done, suppress
 *   - `interrupted` (user hit Esc / Ctrl+C) - user aborted, suppress
 *   - `unknown` (system / summary / unparseable) - suppress
 * so mid-turn writes, compaction events, and aborts do not all
 * masquerade as the same "Claude finished" notification. */
export function isClaudeTurnComplete(tail: string): boolean {
  return classifyClaudeTurn(tail) === "assistant-done";
}
