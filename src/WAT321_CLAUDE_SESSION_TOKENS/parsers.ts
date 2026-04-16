import { readHead } from "../shared/fs/fileReaders";

/**
 * Parsers for Claude Code's `.jsonl` transcript files. The transcript
 * is append-only JSON-lines with one entry per turn/event.
 */

/** Extract text from a Claude message content field. Handles both
 * `content: "string"` and `content: [{type: "text", text: "..."}]`
 * forms used in Claude transcripts. */
function extractTextContent(content: unknown): string | null {
  if (typeof content === "string" && content.length > 0) return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>).type === "text"
      ) {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string" && text.length > 0) return text;
      }
    }
  }
  return null;
}

export interface LastUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
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
      outputTokens:
        typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      modelId: (msg.model as string) || (entry.model as string) || "",
    };
  }
  return null;
}

/**
 * Extract the text content from the most recent assistant turn in
 * the tail. Used for toast notification previews. Returns "" if no
 * assistant message with text content is found.
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

    if (entry.type !== "assistant") continue;
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    const text = extractTextContent(msg.content);
    if (text) return text;
  }
  return "";
}

/**
 * Read the originating cwd out of a transcript's first few lines.
 * Claude transcripts include a `cwd` field on every entry, so the
 * very first parseable line is enough. Returns "" when the file
 * cannot be read or no `cwd` field is found.
 *
 * Used by the cross-project "last known" fallback so the widget can
 * label a transcript from another project with that project's
 * actual basename, instead of misleadingly labeling it with the
 * current workspace's basename.
 */
export function parseCwd(path: string): string {
  // Read a larger head than the default 8KB. Claude Code transcripts
  // often start with a few small control events (permission-mode,
  // model-switch, etc.) that do not carry `cwd`, and the first user
  // turn that does carry `cwd` can land past the 8KB mark on files
  // with long early messages. 32KB is enough to always reach the
  // first user turn without being expensive.
  const head = readHead(path, 32_768);
  if (!head) return "";

  const lines = head.trimEnd().split("\n");
  for (let i = 0; i < lines.length && i < 40; i++) {
    const line = lines[i];
    if (!line) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const cwd = entry.cwd;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  }
  return "";
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

    const text = extractTextContent(msg.content);
    if (text !== null) return text;
  }
  return "";
}
