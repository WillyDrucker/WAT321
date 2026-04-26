import { basename } from "node:path";
import { readFirstLine, readHead } from "../shared/fs/fileReaders";
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
 * Used both to match rollouts to a workspace and to label the widget.
 * `readFirstLine` reads in chunks until a newline, so an oversized
 * session_meta first line (routinely 15-25KB on recent Codex CLI
 * rollouts; can grow further as Codex adds metadata) is always
 * captured intact. */
export function parseCwd(rolloutPath: string): string | null {
  const firstLine = readFirstLine(rolloutPath);
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

/** Classify whether the last meaningful entry in a Codex rollout
 * tail represents a completed assistant turn. Thin wrapper over
 * `classifyCodexTurn` so the detection rules stay in one place.
 *
 * `user` and `assistant-pending` = mid-turn, notification gate should
 * suppress. `assistant-done` and `unknown` = complete, notification
 * gate should fire. The `unknown` -> fire bias matches the original
 * behavior: a missing definitive event must not silently lose a
 * notification. Interrupts (`turn_aborted`) map to `assistant-done`
 * via the classifier, so notifications correctly do not fire on
 * cancelled turns. */
export function isCodexTurnComplete(tail: string): boolean {
  const state = classifyCodexTurn(tail);
  return state === "assistant-done" || state === "unknown";
}

/** Classify the last meaningful entry in a Codex rollout tail into
 * one of the four turn states used by the session token active
 * indicator. Walks backwards, skips bookkeeping events, returns the
 * first definitive event found:
 *   - `assistant-done` - a completed assistant response OR a turn
 *     explicitly ended by `task_complete` / `turn_aborted`. Codex
 *     writes `event_msg` / `turn_aborted` on user interrupt (Esc /
 *     Ctrl+C) and `event_msg` / `task_complete` at normal turn end.
 *     Both resolve the indicator instantly.
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

    // Explicit turn-end signals: Codex writes turn_aborted on user
    // interrupt and task_complete on normal end of turn. Both mean
    // the turn is definitively over.
    if (entry.type === "event_msg" && (ptype === "turn_aborted" || ptype === "task_complete")) {
      return "assistant-done";
    }

    // Assistant-response events = done ONLY for the final_answer
    // phase. Codex 0.124 emits an `agent_message` with
    // phase=commentary mid-turn ("I'll look into X first") before
    // the phase=final_answer message at turn end; treating the
    // commentary message as turn-complete made the thinking
    // indicator flicker idle in the window between commentary and
    // the next reasoning/tool event. Only final_answer + the
    // explicit turn_aborted / task_complete signals close the turn.
    // Commentary-phase messages fall through to keep scanning so a
    // later definitive signal (function_call, reasoning) wins.
    if (entry.type === "event_msg" && ptype === "agent_message") {
      const phase = payload?.phase;
      if (phase === "final_answer") return "assistant-done";
      // phase=commentary or unphased: treat as still-pending, keep
      // walking backward for a stronger signal.
      return "assistant-pending";
    }
    // `response_item/message` role=assistant has no phase tag; it
    // fires for both commentary and final_answer. Without phase we
    // cannot distinguish, so treat as pending and let the backward
    // walk continue searching for an authoritative done signal.
    // Without this fallthrough, catching a commentary message as
    // the tail would mark the turn done mid-work.
    if (entry.type === "response_item" && ptype === "message" && payload?.role === "assistant") {
      return "assistant-pending";
    }
    if (entry.type === "response.output_text.done") return "assistant-done";
    if (entry.type === "message" && payload?.role === "assistant") return "assistant-pending";

    // User messages = user is waiting for a response
    if (ptype === "user_message") return "user";

    // Tool / function calls in flight = assistant is actively working.
    // Codex emits many call variants depending on which tool fired:
    // function_call (custom tools), web_search_call (built-in search),
    // local_shell_call, file_search_call, etc. Any *_call under a
    // response_item means a tool is mid-flight. Bridge-driven sessions
    // rely on this heavily - they have no shell access so they lean on
    // reasoning + built-in tools, which older logic missed entirely.
    if (ptype === "tool_call" || ptype === "function_call") return "assistant-pending";
    if (entry.type === "response_item" && typeof ptype === "string" && ptype.endsWith("_call")) {
      return "assistant-pending";
    }

    // Reasoning chunks under a response_item mean the model is thinking
    // and has not yet emitted the final assistant message. Safe to mark
    // pending: the backwards walk would have returned "assistant-done"
    // first if a later agent_message existed.
    if (entry.type === "response_item" && ptype === "reasoning") return "assistant-pending";

    // Everything else (token_count, turn_context, exec_output) is
    // bookkeeping - keep scanning.
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

/** Walk the tail backwards looking for the most recent compact event.
 * Codex emits two paired entries on every compact (auto-compact at the
 * threshold or `/compact` user invocation):
 *
 *   - `type: "compacted"` (carries the replacement_history payload)
 *   - `type: "event_msg"`, `payload.type: "context_compacted"` (signal-only)
 *
 * Either qualifies; we accept the first match and return its timestamp
 * in ms (epoch). The session token widget uses this to fire a yellow
 * LOAD banner on the trailing render, signaling a deliberate context
 * rebuild rather than letting the resume read as silent.
 *
 * Marker-only detection here. Codex doesn't surface cache_creation /
 * cache_read tokens the way Claude does, so the qualifying rule is
 * "a new compact event has been observed" - no numeric ratio gate. */
export function parseLastCompactTimestamp(tail: string): number | null {
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
    const isCompact =
      entry.type === "compacted" ||
      (entry.type === "event_msg" && payload?.type === "context_compacted");
    if (!isCompact) continue;

    if (typeof entry.timestamp === "string") {
      const ts = Date.parse(entry.timestamp);
      if (!Number.isNaN(ts)) return ts;
    }
    // Compact event without a parseable timestamp; keep walking
    // for an older one with a usable timestamp.
  }
  return null;
}
