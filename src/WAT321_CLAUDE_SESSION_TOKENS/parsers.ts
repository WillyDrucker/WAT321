import { readHead } from "../shared/fs/fileReaders";

/**
 * Parsers for Claude Code's `.jsonl` transcript files. The transcript
 * is append-only JSON-lines with one entry per turn/event.
 */

export interface LastUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelId: string;
}

/**
 * Walk backwards through the tail of a transcript to find the most
 * recent `type: "assistant"` entry that carries `message.usage`. Post-
 * compact or long-tool-result turns can push the last usage-bearing
 * entry well beyond the first 100 lines of a 256KB tail, so this
 * scans every line in the tail window.
 */
export function parseLastUsage(tail: string): LastUsage | null {
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

    if (entry.type !== "assistant") continue;
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg?.usage) continue;

    const usage = msg.usage as Record<string, unknown>;
    return {
      inputTokens:
        typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      cacheCreationTokens:
        typeof usage.cache_creation_input_tokens === "number"
          ? usage.cache_creation_input_tokens
          : 0,
      cacheReadTokens:
        typeof usage.cache_read_input_tokens === "number"
          ? usage.cache_read_input_tokens
          : 0,
      modelId: (msg.model as string) || (entry.model as string) || "",
    };
  }
  return null;
}

/**
 * Read the first user turn out of a transcript to use as the session
 * title. Only the first ~8KB of the file is read (via `readHead`) and
 * at most 20 JSON lines are scanned. Supports both `content: string`
 * and the content-array form with `{ type: "text", text: ... }` parts.
 */
export function parseFirstUserMessage(path: string): string {
  const head = readHead(path);
  if (!head) return "";

  const lines = head.trimEnd().split("\n");
  for (let i = 0; i < lines.length && i < 20; i++) {
    const line = lines[i];
    if (!line) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== "user") continue;
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    const contentField = msg.content;
    if (typeof contentField === "string") return contentField;
    if (Array.isArray(contentField)) {
      for (const part of contentField) {
        if (
          typeof part === "object" &&
          part !== null &&
          (part as Record<string, unknown>).type === "text"
        ) {
          return ((part as Record<string, unknown>).text as string) || "";
        }
      }
    }
  }
  return "";
}
