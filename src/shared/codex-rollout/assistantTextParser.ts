/**
 * Pure parser for the most recent assistant text in a Codex rollout
 * tail. Walks backwards through the tail and matches every known
 * Codex event shape that carries a final-answer payload:
 *
 *   - `event_msg` with `payload.type: "agent_message"` (final answers)
 *   - `response_item` with `payload.type: "message"`, role "assistant"
 *     and `output_text` content parts
 *   - `response.output_text.done` events with inline text
 *   - `message` events with `payload.role: "assistant"` and text content
 *
 * Codex's rollout format evolves across CLI versions, so all known
 * shapes are checked. Returns "" if none found.
 *
 * Lives in `shared/codex-rollout/` so both the Codex session-token
 * widget (notification preview rendering) and the Epic Handshake
 * dispatcher (rollout-recovery fallback when `turn/completed` arrives
 * after our subscription disposed) can read assistant text without
 * a tool tier importing another tool's parser.
 */
export function parseLastAssistantText(tail: string): string {
  const lines = tail.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = entry.payload as Record<string, unknown> | undefined;

    if (entry.type === "event_msg" && payload?.type === "agent_message") {
      const msg = payload.message;
      if (typeof msg === "string" && msg.length > 0) return msg;
    }

    if (entry.type === "response_item" && payload?.type === "message" && payload.role === "assistant") {
      const text = extractOutputText(payload.content);
      if (text) return text;
    }

    if (entry.type === "response.output_text.done") {
      const text = typeof payload?.text === "string" ? payload.text
        : typeof entry.text === "string" ? entry.text
        : null;
      if (text && text.length > 0) return text;
    }

    if (entry.type === "message" && payload?.role === "assistant") {
      const text = extractOutputText(payload.content);
      if (text) return text;
      if (typeof payload.content === "string" && payload.content.length > 0) {
        return payload.content;
      }
    }
  }
  return "";
}

/** Extract text from an `output_text` content array. Shared by
 * multiple Codex event shapes that carry the same content structure. */
function extractOutputText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    if (p.type === "output_text" && typeof p.text === "string" && p.text.length > 0) {
      return p.text;
    }
    if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) {
      return p.text;
    }
  }
  return null;
}
