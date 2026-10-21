import {
  CACHE_REBUILD_CREATION_MIN,
  CACHE_REBUILD_RATIO_DENOM,
} from "../shared/ui/sessionTokens/sessionTokenCacheBannerLatch";
import type { CacheEvent } from "../shared/ui/sessionTokens/sessionTokenTypes";

/**
 * Cache LOAD/MISS classifier for Claude transcripts. Walks back through
 * up to `lookback` assistant turns on the same `tail` string the rest
 * of the parser reads (no file reads, HTTP, or spawns) and reports the
 * most recent cache event for the tooltip only: the banner thresholds
 * in `sessionTokenCacheBannerLatch` are unaffected.
 *
 * Per turn, newest first: cc >= CACHE_REBUILD_CREATION_MIN AND cc >=
 * cr * CACHE_REBUILD_RATIO_DENOM is a rebuild, classified LOAD-compact
 * when the preceding user entry `isCompactSummary`, MISS-TTL when the
 * gap from the prior assistant ts to the user ts exceeds
 * CACHE_TTL_GAP_MS, MISS-large-payload when the preceding user entry
 * carries a tool_result of LARGE_TOOL_RESULT_BYTES or more, else
 * MISS-unknown. No rebuild in the lookback window is HIT-clean.
 */

/** Cache TTL gap. A user prompt landing more than this many ms
 * after the prior assistant turn lost its prompt cache. */
const CACHE_TTL_GAP_MS = 5 * 60 * 1000;
/** Tool-result content size flagged as "large payload". */
const LARGE_TOOL_RESULT_BYTES = 50_000;
// Cache-rebuild detection shares the banner latch's thresholds so the
// tooltip and the banner never disagree: a looser floor here would
// classify an incremental write as a LOAD the banner never showed.

interface TurnRecord {
  assistantTs: number;
  cc: number;
  cr: number;
  userTs: number | null;
  isPostCompact: boolean;
  toolResultBytes: number;
}

export function parseMostRecentCacheEvent(
  tail: string,
  lookback = 10
): CacheEvent {
  const turns = collectRecentTurns(tail, lookback);

  // turns[0] is the most recent assistant turn.
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.cc < CACHE_REBUILD_CREATION_MIN) continue;
    const ago = describeTurnsAgo(i);

    // Compact-driven rebuilds qualify on the creation floor alone -
    // mirrors the banner's `meetsCompact` exception. Compact bundles
    // a fresh summary alongside surviving system prompt + tools, so
    // creation is meaningful but reads can be non-trivial - the
    // strict ratio gate would miss most compact LOADs and let the
    // tooltip disagree with the banner. Check before the ratio gate.
    if (t.isPostCompact) {
      return {
        kind: "LOAD-compact",
        description: `LOAD - post-compact rebuild (${ago})`,
        ts: t.assistantTs,
      };
    }

    if (t.cc < t.cr * CACHE_REBUILD_RATIO_DENOM) continue;
    const prior = turns[i + 1];
    if (prior !== undefined && t.userTs !== null) {
      const gapMs = t.userTs - prior.assistantTs;
      if (gapMs > CACHE_TTL_GAP_MS) {
        const gapMin = Math.round(gapMs / 60_000);
        return {
          kind: "MISS-TTL",
          description: `MISS - TTL expiration (~${gapMin} min gap, ${ago})`,
          ts: t.assistantTs,
        };
      }
    }
    if (t.toolResultBytes >= LARGE_TOOL_RESULT_BYTES) {
      const kb = Math.round(t.toolResultBytes / 1024);
      return {
        kind: "MISS-large-payload",
        description: `MISS - large tool payload (~${kb} KB tool result, ${ago})`,
        ts: t.assistantTs,
      };
    }
    // Ruled out: TTL gap, large tool payload, post-compact rebuild.
    // Most likely remaining causes for a prefix-rebuild we can't
    // pin from the transcript:
    //   - Tool schema change (MCP server reinstall, tool list shift)
    //   - System-prompt mutation (<system-reminder> content varies)
    //   - Claude Code internal cache reset (not observable here)
    // Surfacing the ruled-out bucket tells the user we checked the
    // obvious causes and they're not the answer.
    return {
      kind: "MISS-unknown",
      description: `MISS - prefix rebuilt (${ago}); ruled out TTL/large-payload/compact. Likely tool schema or system-prompt change.`,
      ts: t.assistantTs,
    };
  }

  if (turns.length === 0) {
    return { kind: "HIT-clean", description: "no recent activity", ts: null };
  }
  return { kind: "HIT-clean", description: "Clean", ts: null };
}

/** Walk the tail backwards collecting assistant/user turn pairs.
 * Returns newest first. Stops once `limit` turns are gathered. */
function collectRecentTurns(tail: string, limit: number): TurnRecord[] {
  const lines = tail.trimEnd().split("\n");
  const turns: TurnRecord[] = [];
  let pending: TurnRecord | null = null;

  for (let i = lines.length - 1; i >= 0 && turns.length < limit; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "assistant") {
      // A new assistant entry without a paired user means the prior
      // pending record has no preceding user info (tool-result
      // assistant-only sequence). Push it as-is and start fresh.
      if (pending !== null) {
        turns.push(pending);
        pending = null;
        if (turns.length >= limit) break;
      }
      const msg = entry.message as Record<string, unknown> | undefined;
      const usage = msg?.usage as Record<string, unknown> | undefined;
      if (!usage) continue;
      const ts = parseEntryTimestamp(entry);
      if (ts === null) continue;
      pending = {
        assistantTs: ts,
        cc: numericField(usage, "cache_creation_input_tokens"),
        cr: numericField(usage, "cache_read_input_tokens"),
        userTs: null,
        isPostCompact: false,
        toolResultBytes: 0,
      };
    } else if (entry.type === "user" && pending !== null) {
      pending.userTs = parseEntryTimestamp(entry);
      pending.isPostCompact = entry.isCompactSummary === true;
      pending.toolResultBytes = sumToolResultBytes(entry);
      turns.push(pending);
      pending = null;
    }
  }

  if (pending !== null && turns.length < limit) turns.push(pending);
  return turns;
}

function parseEntryTimestamp(entry: Record<string, unknown>): number | null {
  const tsRaw = entry.timestamp;
  if (typeof tsRaw !== "string") return null;
  const t = Date.parse(tsRaw);
  return Number.isNaN(t) ? null : t;
}

function numericField(
  src: Record<string, unknown>,
  key: string
): number {
  const v = src[key];
  return typeof v === "number" ? v : 0;
}

function sumToolResultBytes(entry: Record<string, unknown>): number {
  const msg = entry.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (!Array.isArray(content)) return 0;
  let bytes = 0;
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    if (p.type !== "tool_result") continue;
    const c = p.content;
    if (typeof c === "string") bytes += c.length;
    else if (c !== undefined) bytes += JSON.stringify(c).length;
  }
  return bytes;
}

function describeTurnsAgo(n: number): string {
  if (n === 0) return "this turn";
  if (n === 1) return "1 turn ago";
  return `${n} turns ago`;
}
