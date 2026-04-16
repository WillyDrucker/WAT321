import { basename } from "node:path";
import { readHead } from "../shared/fs/fileReaders";

/**
 * Parsers for Codex rollout `.jsonl` transcripts. Rollouts live under
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` with one entry per
 * line. Every entry is `{ type, payload }` where payload.type names
 * the specific event kind (session_meta, turn_context, token_count,
 * user_message, etc.).
 */

export interface LastTokenCount {
  /** Tokens currently in the context window for the last completed
   * turn. Sourced from `last_token_usage.total_tokens` in the Codex
   * rollout's `token_count` event, matching what Codex's own TUI
   * displays via `TokenUsage::tokens_in_context_window` upstream. */
  tokens: number;
  contextWindowSize: number;
}

const DEFAULT_CODEX_CONTEXT_WINDOW = 258_400;

/** Scan the tail (up to the last 200 lines) for the most recent
 * `token_count` event. Returns `last_token_usage.total_tokens` (with
 * a fallback to `input_tokens` for older rollout formats) and the
 * `model_context_window` reported on that event. */
export function parseLastTokenCount(tail: string): LastTokenCount | null {
  const lines = tail.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
    const line = lines[i];
    if (!line) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = entry.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== "token_count") continue;

    const info = payload.info as Record<string, unknown> | undefined;
    if (!info) continue;

    const lastUsage = info.last_token_usage as Record<string, unknown> | undefined;
    if (!lastUsage) continue;

    // Codex's own TUI displays `total_tokens` (not `input_tokens`)
    // via `TokenUsage::tokens_in_context_window()` in
    // `codex-rs/protocol/src/protocol.rs`. `total_tokens` includes
    // input + output for the last turn, so it reflects the full
    // context-window footprint of that turn. Using `input_tokens`
    // alone undercounts by ~500-1000 tokens per turn (the output
    // component) and the gap compounds over a long session. Fall
    // back to `input_tokens` only when `total_tokens` is missing,
    // which should not happen on any current Codex version.
    const tokens =
      typeof lastUsage.total_tokens === "number"
        ? lastUsage.total_tokens
        : typeof lastUsage.input_tokens === "number"
          ? lastUsage.input_tokens
          : null;
    if (tokens === null) continue;

    return {
      tokens,
      contextWindowSize:
        typeof info.model_context_window === "number"
          ? info.model_context_window
          : DEFAULT_CODEX_CONTEXT_WINDOW,
    };
  }
  return null;
}

/** Read `session_meta.payload.cwd` from the first line of the rollout.
 * Used both to match rollouts to a workspace and to label the widget. */
export function parseCwd(rolloutPath: string): string | null {
  const head = readHead(rolloutPath, 32_768);
  if (!head) return null;

  const firstLine = head.split("\n")[0];
  if (!firstLine) return null;

  try {
    const entry = JSON.parse(firstLine);
    if (entry.type === "session_meta") {
      return (entry.payload?.cwd as string) || null;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Scan the header for the active model slug. Checks `turn_context`
 * first (set on every turn after the first) and falls back to
 * `session_meta.payload.model` for freshly started sessions. */
export function parseModelSlug(rolloutPath: string): string | null {
  const head = readHead(rolloutPath, 65_536);
  if (!head) return null;

  const lines = head.split("\n");
  for (let i = 0; i < lines.length && i < 80; i++) {
    const line = lines[i];
    if (!line) continue;

    try {
      const entry = JSON.parse(line);
      if (
        entry.type === "turn_context" &&
        typeof entry.payload?.model === "string"
      ) {
        return entry.payload.model;
      }
      if (
        entry.type === "session_meta" &&
        typeof entry.payload?.model === "string"
      ) {
        return entry.payload.model;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** First user message text, used as the widget's session title when
 * `session_index.jsonl` has no `thread_name` for this session. */
export function extractFirstUserMessage(headContent: string): string {
  const lines = headContent.trimEnd().split("\n");
  for (let i = 0; i < lines.length && i < 30; i++) {
    const line = lines[i];
    if (!line) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = entry.payload as Record<string, unknown> | undefined;
    if (!payload) continue;

    if (payload.type === "user_message") {
      const msg = payload.message;
      if (typeof msg === "string") return msg.trim();
    }
  }
  return "";
}

/** Extract the text content from the most recent assistant message in
 * the tail. Codex uses `event_msg` with `payload.type: "agent_message"`
 * for final answers. Returns "" if none found. */
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

    if (entry.type === "event_msg") {
      const payload = entry.payload as Record<string, unknown> | undefined;
      if (payload?.type === "agent_message") {
        const msg = payload.message;
        if (typeof msg === "string" && msg.length > 0) return msg;
      }
    }

    if (entry.type === "response_item") {
      const payload = entry.payload as Record<string, unknown> | undefined;
      if (payload?.type === "message" && payload.role === "assistant") {
        const content = payload.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (
              typeof part === "object" &&
              part !== null &&
              (part as Record<string, unknown>).type === "output_text"
            ) {
              const text = (part as Record<string, unknown>).text;
              if (typeof text === "string" && text.length > 0) return text;
            }
          }
        }
      }
    }
  }
  return "";
}

/** Codex rollout filenames are `rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl`.
 * The session ID is everything after the 7th `-`-separated field. */
export function extractSessionId(rolloutPath: string): string {
  const filename = basename(rolloutPath, ".jsonl");
  const parts = filename.split("-");
  if (parts.length > 6) return parts.slice(6).join("-");
  return filename;
}
