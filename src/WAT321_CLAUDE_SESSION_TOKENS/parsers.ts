import { readHead } from "../engine/fs/fileReaders";
import type {
  CacheEvent,
  CacheEventKind,
  ClaudeTurnInfo,
} from "../shared/ui/sessionTokens/sessionTokenWidget";

/**
 * Small extractors for Claude Code's `.jsonl` transcripts. Each
 * function walks the tail / head looking for a specific field
 * (last usage, last assistant text, cwd, first user message) and
 * returns it - no aggregation, no classification.
 *
 * Bigger concerns live in sibling files:
 *   - `turnInfoParser.ts` - per-turn aggregation (parseTurnInfo,
 *     parseRecentCompactBoundaries)
 *   - `cacheEventParser.ts` - LOAD/MISS classification
 *     (parseMostRecentCacheEvent)
 *
 * The shared display types (`ClaudeTurnInfo`, `CacheEvent`,
 * `CacheEventKind`) are re-exported here so callers in this tool
 * can import them from `./parsers` without knowing about the
 * shared-ui module.
 */

export type { CacheEvent, CacheEventKind, ClaudeTurnInfo };

/** Extract text from a Claude message content field. Handles both
 * `content: "string"` and `content: [{type: "text", text: "..."}]`. */
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

interface LastUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  modelId: string;
}

/** Walk backwards through the tail to find the most recent
 * `type: "assistant"` entry that carries `message.usage`. Post-
 * compact or long-tool-result turns can push the last usage-bearing
 * entry well beyond the first 100 lines of a 256KB tail, so this
 * scans every line in the window. */
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

/** Extract the text content from the most recent assistant turn in
 * the tail. Used for toast notification previews. Returns "" if no
 * assistant message with text content is found. */
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

/** Read the originating cwd out of a transcript's first few lines.
 * Claude transcripts include a `cwd` field on every entry, so the
 * first parseable line is enough. Returns null when the file cannot
 * be read or no `cwd` is found. Symmetric with Codex's `parseCwd`
 * (see `WAT321_CODEX_SESSION_TOKENS/parsers.ts`) so callers using both
 * providers handle the miss case the same way.
 *
 * Used by the cross-project "last known" fallback so the widget can
 * label a transcript from another project with that project's basename,
 * instead of misleadingly labeling it with the current workspace's. */
export function parseCwd(path: string): string | null {
  // Read a larger head than the default 8KB. Transcripts often
  // start with a few small control events (permission-mode, model-
  // switch) that don't carry `cwd`, and the first user turn that
  // does can land past the 8KB mark on files with long early
  // messages. 32KB is enough to always reach it without being
  // expensive.
  const head = readHead(path, 32_768);
  if (!head) return null;

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
  return null;
}

/** Slash-command scaffolding that Claude Code records as `type:
 * "user"` entries ahead of the human's actual opening prompt. A
 * session started with a slash command lays down a caveat entry, the
 * command envelope, and the command's stdout before the real message.
 * Titling the tooltip off any of them surfaces "Caveat: The messages
 * below were generated by..." where the session's opening line
 * belongs. Matched as prefixes so wording drift across Claude Code
 * releases does not reintroduce the leak. */
const SYNTHETIC_USER_PREFIXES = [
  "<local-command-caveat>",
  "Caveat: The messages below were generated",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<command-contents>",
  "<local-command-stdout>",
] as const;

function isSyntheticUserText(text: string): boolean {
  const head = text.trimStart();
  return SYNTHETIC_USER_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/** Read the first human user turn out of a transcript to use as the
 * session title. Supports both `content: string` and the content-array
 * form with `{ type: "text", text: ... }` parts.
 *
 * Reads a 32KB head rather than `readHead`'s default 8KB: a session
 * opened with a slash command can carry several kilobytes of command
 * args before the human's first line, and the same budget already
 * covers `parseCwd` for the same reason. The 40-line scan window has
 * the matching headroom - scaffolding entries cost lines too. */
export function parseFirstUserMessage(path: string): string {
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

    if (entry.type !== "user") continue;
    // `isMeta` flags Claude Code's own bookkeeping turns. Never a human prompt.
    if (entry.isMeta === true) continue;
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    const text = extractTextContent(msg.content);
    if (text === null || isSyntheticUserText(text)) continue;
    return text;
  }
  return "";
}
