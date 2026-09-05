import type { ClaudeTurnInfo } from "../shared/ui/sessionTokens/sessionTokenWidget";
import { parseMostRecentCacheEvent } from "./cacheEventParser";

/**
 * Turn-level aggregators for Claude `.jsonl` transcripts. Both
 * walk the tail backwards once and assemble structured snapshots
 * the widget consumes on every poll.
 *
 *   - `parseTurnInfo(tail)` -> `ClaudeTurnInfo` for the tooltip /
 *     widget activity indicator. Aggregates the most recent
 *     assistant turn's usage, tool-call counter, thinking-block
 *     presence, and the compact-summary watermark.
 *   - `parseRecentCompactBoundaries(tail, limit)` -> structured
 *     end-of-compact signals from `system/compact_boundary` entries
 *     (recent Claude Code releases). Drives the compact state
 *     machine's clean-exit transition.
 */

/** Structured signal Claude Code writes at the end of every
 * compact. Empirically verified against recent Claude Code releases.
 *
 *   {
 *     "type": "system",
 *     "subtype": "compact_boundary",
 *     "content": "Conversation compacted",
 *     "timestamp": "...",
 *     "compactMetadata": {
 *       "trigger": "manual" | "auto",
 *       "preTokens": <int>,
 *       "durationMs": <int>,
 *       "postTokens": <int>,
 *       ...
 *     }
 *   }
 */
interface CompactBoundary {
  /** ms since epoch parsed from the entry's `timestamp` field. */
  at: number;
  trigger: string;
  preTokens: number;
  durationMs: number;
  postTokens: number;
}

/** Walk the tail backwards and parse compact_boundary system
 * entries. Returns the most recent `limit` entries, oldest first.
 * Malformed entries skipped silently. */
export function parseRecentCompactBoundaries(
  tail: string,
  limit: number
): CompactBoundary[] {
  const lines = tail.trimEnd().split("\n");
  const out: CompactBoundary[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "system" || entry.subtype !== "compact_boundary") {
      continue;
    }
    const tsRaw = entry.timestamp;
    const at = typeof tsRaw === "string" ? Date.parse(tsRaw) : NaN;
    if (Number.isNaN(at)) continue;
    const meta = entry.compactMetadata as Record<string, unknown> | undefined;
    if (!meta) continue;
    const trigger = typeof meta.trigger === "string" ? meta.trigger : "auto";
    const preTokens = typeof meta.preTokens === "number" ? meta.preTokens : 0;
    const durationMs =
      typeof meta.durationMs === "number" ? meta.durationMs : 0;
    const postTokens =
      typeof meta.postTokens === "number" ? meta.postTokens : 0;
    if (durationMs <= 0) continue;
    out.unshift({ at, trigger, preTokens, durationMs, postTokens });
  }
  return out;
}

/** Compose a `ClaudeTurnInfo` snapshot from a transcript tail.
 * Walks backwards once, aggregates tool_use names, detects thinking
 * blocks, and captures the last assistant turn's usage. Cheap enough
 * to call on every poll - a single tail pass. */
export function parseTurnInfo(tail: string): ClaudeTurnInfo {
  const lines = tail.trimEnd().split("\n");

  let activeToolName: string | null = null;
  let activeToolLocked = false;
  let toolCallCount = 0;
  let hasThinkingRecent = false;
  let outputTokens = 0;
  let totalInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let lastCompactTimestamp: number | null = null;
  let usageLocked = false;
  let thinkingScanBudget = 20;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "user") {
      // User message closes the current turn - stop counting tool
      // calls. If this closing user is itself a compact summary,
      // capture its timestamp so the widget can classify the
      // trailing assistant turn's cache rebuild as a compact-driven
      // LOAD rather than an involuntary MISS.
      if (
        entry.isCompactSummary === true &&
        typeof entry.timestamp === "string"
      ) {
        const ts = Date.parse(entry.timestamp);
        if (!Number.isNaN(ts)) lastCompactTimestamp = ts;
      }
      break;
    }

    if (entry.type !== "assistant") continue;
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    // First assistant entry encountered (walking backwards = newest)
    // supplies the usage snapshot and the active tool name if any.
    if (!usageLocked) {
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (usage) {
        outputTokens =
          typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
        const input =
          typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        cacheCreationTokens =
          typeof usage.cache_creation_input_tokens === "number"
            ? usage.cache_creation_input_tokens
            : 0;
        cachedInputTokens =
          typeof usage.cache_read_input_tokens === "number"
            ? usage.cache_read_input_tokens
            : 0;
        totalInputTokens = input + cacheCreationTokens + cachedInputTokens;
        usageLocked = true;
      }
    }

    const content = msg.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part !== "object" || part === null) continue;
        const p = part as Record<string, unknown>;
        if (p.type === "tool_use") {
          toolCallCount++;
          if (!activeToolLocked && typeof p.name === "string") {
            activeToolName = p.name;
            activeToolLocked = true;
          }
        } else if (p.type === "thinking") {
          hasThinkingRecent = true;
        }
      }
    }

    if (--thinkingScanBudget <= 0 && usageLocked && activeToolLocked) {
      // Have enough signal - bail rather than walk the rest of the
      // tail. thinkingScanBudget also caps how far back we look for
      // thinking blocks so very old blocks do not keep the indicator
      // on.
      break;
    }
  }

  return {
    activeToolName,
    toolCallCount,
    hasThinkingRecent,
    outputTokens,
    totalInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    lastCompactTimestamp,
    mostRecentCacheEvent: parseMostRecentCacheEvent(tail),
  };
}
