import { readHead } from "../shared/fs/fileReaders";
import type {
  CacheEvent,
  CacheEventKind,
  ClaudeTurnInfo,
} from "../shared/ui/sessionTokenWidget";

/**
 * Parsers for Claude Code's `.jsonl` transcript files. The transcript
 * is append-only JSON-lines with one entry per turn/event.
 */

/** Re-export the shared display types so callers in this tool can
 * continue to import them from the parsers module without knowing
 * about the shared-ui module. The interfaces themselves live in shared
 * to keep the generic session-token widget independent of tool
 * folders. */
export type { CacheEvent, CacheEventKind, ClaudeTurnInfo };

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

/** Cache TTL gap threshold. A user prompt that lands more than this
 * many ms after the prior assistant turn lost its prompt cache. */
const CACHE_TTL_GAP_MS = 5 * 60 * 1000;
/** Tool-result content size threshold flagged as "large payload". */
const LARGE_TOOL_RESULT_BYTES = 50_000;
/** Cache-rebuild detection mirrors `maybeLatchCacheBanner` thresholds.
 * Do not adjust these without a fresh false-fire audit - they were
 * dialed in across the v1.2.10 / v1.2.11 work to suppress spurious
 * fires on normal incremental cache writes. */
const REBUILD_CC_FLOOR = 5_000;
const REBUILD_RATIO_DENOM = 2;

/**
 * Walk back through up to `lookback` assistant turns to detect and
 * classify the most recent cache event. Pure transcript-derived. Reads
 * only the same `tail` string the rest of the parser already operates
 * on; makes no file reads, no HTTP calls, no process spawns. Output
 * powers a tooltip-only readout - no banner flashing, no alarms.
 *
 * Detection:
 *   - cc >= 5000 AND cc >= cr * 2 -> rebuild detected. Classify by:
 *     - preceding user has isCompactSummary -> LOAD-compact
 *     - gap from prior assistant ts to current user ts > 5 min -> MISS-TTL
 *     - preceding user has tool_result content >= 50 KB -> MISS-large-payload
 *     - else -> MISS-unknown
 *   - No rebuild in lookback window -> HIT-clean.
 *
 * Note: this is read-only diagnosis. The cache LOAD/MISS banner
 * thresholds in `sessionTokenWidget.ts:maybeLatchCacheBanner` are
 * unaffected. This function only adds tooltip visibility for events
 * that would otherwise be silent.
 */
export function parseMostRecentCacheEvent(
  tail: string,
  lookback = 10
): CacheEvent {
  interface TurnRecord {
    assistantTs: number;
    cc: number;
    cr: number;
    userTs: number | null;
    isPostCompact: boolean;
    toolResultBytes: number;
  }

  const lines = tail.trimEnd().split("\n");
  const turns: TurnRecord[] = [];
  let pending: TurnRecord | null = null;

  for (let i = lines.length - 1; i >= 0 && turns.length < lookback; i--) {
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
      // pending record has no preceding user info (e.g. tool-result
      // assistant-only sequence). Push it as-is and start fresh.
      if (pending !== null) {
        turns.push(pending);
        pending = null;
        if (turns.length >= lookback) break;
      }
      const msg = entry.message as Record<string, unknown> | undefined;
      const usage = msg?.usage as Record<string, unknown> | undefined;
      if (!usage) continue;
      const tsRaw = entry.timestamp;
      const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : NaN;
      if (Number.isNaN(ts)) continue;
      pending = {
        assistantTs: ts,
        cc:
          typeof usage.cache_creation_input_tokens === "number"
            ? usage.cache_creation_input_tokens
            : 0,
        cr:
          typeof usage.cache_read_input_tokens === "number"
            ? usage.cache_read_input_tokens
            : 0,
        userTs: null,
        isPostCompact: false,
        toolResultBytes: 0,
      };
    } else if (entry.type === "user" && pending !== null) {
      const tsRaw = entry.timestamp;
      const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : NaN;
      pending.userTs = Number.isNaN(ts) ? null : ts;
      pending.isPostCompact = entry.isCompactSummary === true;
      const msg = entry.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      if (Array.isArray(content)) {
        let bytes = 0;
        for (const part of content) {
          if (typeof part !== "object" || part === null) continue;
          const p = part as Record<string, unknown>;
          if (p.type !== "tool_result") continue;
          const c = p.content;
          if (typeof c === "string") bytes += c.length;
          else if (c !== undefined) bytes += JSON.stringify(c).length;
        }
        pending.toolResultBytes = bytes;
      }
      turns.push(pending);
      pending = null;
    }
  }

  if (pending !== null && turns.length < lookback) turns.push(pending);

  // turns[0] is the most recent assistant turn.
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.cc < REBUILD_CC_FLOOR) continue;
    const ago = describeTurnsAgo(i);

    // Compact-driven rebuilds qualify on the creation floor alone -
    // mirrors the banner's `meetsCompact` exception. Compact bundles
    // a fresh summary alongside surviving system prompt + tools, so
    // creation is meaningful but reads can be non-trivial; the strict
    // ratio gate would miss most compact LOADs and let the tooltip
    // disagree with the banner. Check this before the ratio gate.
    if (t.isPostCompact) {
      return {
        kind: "LOAD-compact",
        description: `LOAD - post-compact rebuild (${ago})`,
        ts: t.assistantTs,
      };
    }

    if (t.cc < t.cr * REBUILD_RATIO_DENOM) continue;
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
    return {
      kind: "MISS-unknown",
      description: `MISS - prefix change, cause unclear (${ago})`,
      ts: t.assistantTs,
    };
  }

  if (turns.length === 0) {
    return { kind: "HIT-clean", description: "no recent activity", ts: null };
  }
  return {
    kind: "HIT-clean",
    description: `HIT - clean (last ${turns.length} turn${turns.length === 1 ? "" : "s"} all hit)`,
    ts: null,
  };
}

function describeTurnsAgo(n: number): string {
  if (n === 0) return "this turn";
  if (n === 1) return "1 turn ago";
  return `${n} turns ago`;
}

/** Compose a `ClaudeTurnInfo` snapshot from a transcript tail. Walks
 * backwards once, aggregates tool_use names, detects thinking blocks,
 * and captures the last assistant turn's usage. Cheap enough to call
 * on every poll - a single tail pass. */
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
      // calls at this boundary. If the closing user entry is itself
      // a compact summary, capture its timestamp so the widget can
      // classify the trailing assistant turn's cache rebuild as a
      // compact-driven LOAD rather than an involuntary MISS.
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
      // Have enough signal; bail out rather than walk the rest of the
      // tail. thinkingScanBudget also caps how far back we look for
      // thinking blocks so very old blocks do not keep the indicator on.
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
