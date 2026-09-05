import { basename } from "node:path";
import { readFirstLine, readHead } from "../engine/fs/fileReaders";

/**
 * Field extraction from Codex rollout `.jsonl` transcripts. Rollouts
 * live under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` with one
 * entry per line, each `{ type, payload }` where payload.type names the
 * event kind (session_meta, turn_context, token_count, user_message).
 * Turn-state classification lives in `turnClassifier.ts`.
 */

interface LastTokenCount {
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
 * rollouts - can grow further as Codex adds metadata) is always
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
 * Either qualifies. We accept the first match and return its timestamp
 * in ms (epoch). Drives two consumers: the yellow LOAD banner on the
 * trailing render (deliberate context rebuild, not a silent resume) and
 * the compact-completion flash (`CompactFlashMachine` boundary input).
 * Matching BOTH markers is deliberate for the flash: `compacted` can
 * be a very large line (it carries `replacement_history`) and may be
 * truncated out of the tail window, but the paired `context_compacted`
 * is tiny, always written immediately after, and walked first here -
 * so the flash still fires even when `compacted` is unreadable.
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
    // Compact event without a parseable timestamp - keep walking
    // for an older one with a usable timestamp.
  }
  return null;
}
