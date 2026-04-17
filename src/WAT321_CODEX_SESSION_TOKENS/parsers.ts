import { basename } from "node:path";
import { readHead } from "../shared/fs/fileReaders";
import type { LastEntryKind } from "../shared/transcriptClassifier";

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

/** Scan the header for the initial model slug. Checks `turn_context`
 * first (set on every turn after the first) and falls back to
 * `session_meta.payload.model` for freshly started sessions. Used
 * only as a fallback when `parseLatestModelSlug` finds nothing in
 * the tail. */
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

/** Scan the tail backwards for the most recent `turn_context` model
 * slug. Catches mid-session `/model` switches that the header-only
 * `parseModelSlug` would miss. Returns null if no `turn_context`
 * is found in the tail window. */
export function parseLatestModelSlug(tail: string): string | null {
  const lines = tail.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
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
 * the tail. Walks backwards through the rollout scanning multiple
 * Codex event shapes:
 *
 *   - `event_msg` with `payload.type: "agent_message"` (final answers)
 *   - `response_item` with `payload.type: "message"`, role "assistant"
 *     and `output_text` content parts
 *   - `response.output_text.done` events with inline text
 *   - `message` events with `payload.role: "assistant"` and text content
 *
 * Codex has evolved its rollout format across versions, so we check
 * all known shapes. Returns "" if none found. */
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

    // Shape 1: event_msg with agent_message payload
    if (entry.type === "event_msg" && payload?.type === "agent_message") {
      const msg = payload.message;
      if (typeof msg === "string" && msg.length > 0) return msg;
    }

    // Shape 2: response_item with assistant message + output_text parts
    if (entry.type === "response_item" && payload?.type === "message" && payload.role === "assistant") {
      const text = extractOutputText(payload.content);
      if (text) return text;
    }

    // Shape 3: response.output_text.done with inline text
    if (entry.type === "response.output_text.done") {
      const text = typeof payload?.text === "string" ? payload.text
        : typeof entry.text === "string" ? entry.text
        : null;
      if (text && text.length > 0) return text;
    }

    // Shape 4: message event with assistant role
    if (entry.type === "message" && payload?.role === "assistant") {
      const text = extractOutputText(payload.content);
      if (text) return text;
      // Plain string content
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
    // Also check plain text parts
    if (p.type === "text" && typeof p.text === "string" && p.text.length > 0) {
      return p.text;
    }
  }
  return null;
}

/** Classify whether the last meaningful entry in a Codex rollout
 * tail represents a completed assistant turn. Walks backwards,
 * skipping bookkeeping events, and returns true when it finds a
 * known assistant-response event. Returns false only for known
 * mid-turn events (user messages, tool execution). Unrecognized
 * event types are skipped rather than rejected so new Codex event
 * types don't silently suppress notifications. */
export function isCodexTurnComplete(tail: string): boolean {
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
    const ptype = payload?.type as string | undefined;

    // Known assistant-response events = turn complete
    if (entry.type === "event_msg" && ptype === "agent_message") return true;
    if (entry.type === "response_item" && ptype === "message" && payload?.role === "assistant") return true;
    if (entry.type === "response.output_text.done") return true;
    if (entry.type === "message" && payload?.role === "assistant") return true;

    // Known mid-turn events = turn NOT complete, stop scanning
    if (ptype === "user_message") return false;
    if (ptype === "tool_call" || ptype === "function_call") return false;
    if (entry.type === "response_item" && ptype === "function_call") return false;

    // Everything else (token_count, turn_context, reasoning,
    // exec_output, task events, etc.) is bookkeeping - skip and
    // keep scanning backwards for a definitive event.
  }
  // No definitive event found in the tail. Bias toward firing so
  // a notification is not silently lost.
  return true;
}

/** Classify the last meaningful entry in a Codex rollout tail into
 * one of the four turn states used by the session token active
 * indicator. Walks backwards, skips bookkeeping events, returns the
 * first definitive event found:
 *   - `assistant-done` - a completed assistant response
 *   - `assistant-pending` - a tool / function call in flight
 *   - `user` - last event was a user message (user is waiting)
 *   - `unknown` - no definitive event in the tail window
 *
 * Unlike `isCodexTurnComplete` (which biases toward true for
 * notification firing), this biases `unknown` to idle so the thinking
 * indicator does not pin itself on when we cannot tell. */
export function classifyCodexTurn(tail: string): LastEntryKind {
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
    const ptype = payload?.type as string | undefined;

    // Assistant-response events = done
    if (entry.type === "event_msg" && ptype === "agent_message") return "assistant-done";
    if (entry.type === "response_item" && ptype === "message" && payload?.role === "assistant") return "assistant-done";
    if (entry.type === "response.output_text.done") return "assistant-done";
    if (entry.type === "message" && payload?.role === "assistant") return "assistant-done";

    // User messages = user is waiting for a response
    if (ptype === "user_message") return "user";

    // Tool / function calls in flight = assistant is actively working
    if (ptype === "tool_call" || ptype === "function_call") return "assistant-pending";
    if (entry.type === "response_item" && ptype === "function_call") return "assistant-pending";

    // Everything else (token_count, turn_context, reasoning,
    // exec_output, task events) is bookkeeping - keep scanning.
  }
  return "unknown";
}

/** Codex rollout filenames are `rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl`.
 * The session ID is everything after the 7th `-`-separated field. */
export function extractSessionId(rolloutPath: string): string {
  const filename = basename(rolloutPath, ".jsonl");
  const parts = filename.split("-");
  if (parts.length > 6) return parts.slice(6).join("-");
  return filename;
}
