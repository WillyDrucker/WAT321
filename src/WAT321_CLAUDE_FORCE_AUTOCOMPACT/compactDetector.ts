import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * Detects a Claude auto-compact by scanning appended bytes of the
 * watched transcript for the `"isCompactSummary":true` marker. Claude
 * Code's `.jsonl` transcripts are append-only so file size never drops
 * on compact; byte-level scanning from a rolling offset is the only
 * reliable signal.
 *
 * Two scanners live in this module:
 *
 *   - `scanForCompactMarker`: the armed-state rolling scanner. Reads
 *     from a moving offset and signals "found" on the next poll after
 *     a compact writes its marker.
 *
 *   - `scanTailForCompactHistory`: the preflight / cooldown-watcher
 *     scanner. Reads a bounded tail window once, counts markers, and
 *     returns the age of the most recent one. Used by the traffic
 *     gate to detect "compact just happened" and "session is already
 *     looping" without keeping any rolling state.
 */

export const COMPACT_MARKER = Buffer.from('"isCompactSummary":true');

/** Cap each poll's scan window so a very active session cannot pin
 * us on a giant read. New compact summaries are tiny; 2 MB of fresh
 * bytes per poll is far more than enough. */
export const MAX_SCAN_BYTES_PER_POLL = 2_000_000;

/** Tail window read by `scanTailForCompactHistory`. 256 KB is enough
 * to cover several consecutive compact summaries on a busy session
 * while still completing in sub-millisecond time on any modern disk.
 * The preflight gate and post-disarm cooldown watcher both use this
 * scanner, so the cost is paid at most once per arm click or once
 * per 2-second cooldown tick - never in the idle poll path. */
export const TAIL_HISTORY_SCAN_BYTES = 256_000;

export interface ScanOutcome {
  /** True if the marker was found in the bytes scanned this poll. */
  found: boolean;
  /** Offset to resume scanning from next poll (includes overlap). */
  nextOffset: number;
}

/** Classification of the last parseable JSONL entry in the tail.
 * Used by the preflight gate's `claude-busy` check so we can refuse
 * arming while Claude is mid-turn. */
export type LastEntryKind =
  /** Last entry is a user message (prompt or tool_result). Claude
   * is about to respond - queued prompt or tool callback. */
  | "user"
  /** Last entry is an assistant message containing an unresolved
   * `tool_use` block. Claude is waiting on tool execution. */
  | "assistant-pending"
  /** Last entry is an assistant text-only message. Turn complete,
   * Claude is idle. */
  | "assistant-done"
  /** Could not classify (empty tail, unparseable, unknown type).
   * Treated as "idle" by the resolver so a broken scanner never
   * blocks arming. */
  | "unknown";

export interface TailHistoryOutcome {
  /** Count of `"isCompactSummary":true` markers seen in the tail. */
  markerCount: number;
  /** Raw file mtime in ms since epoch (from `statSync`), or 0 if
   * the file could not be stat'd. Callers compute the age at
   * resolve time as `Date.now() - mtimeMs` so the loop-detection
   * backup gate ages forward correctly even when the cached
   * outcome is reused across many ticks with no new transcript
   * writes. Do NOT store a precomputed `age` here - it would
   * freeze at scan time and the gate could stick indefinitely.
   * Used ONLY as a secondary loop-detection signal behind the
   * primary context-fraction gate. */
  mtimeMs: number;
  /** Classification of the last parseable JSONL entry. Feeds the
   * `claude-busy` arm gate so we do not arm mid-turn. */
  lastEntryKind: LastEntryKind;
  /** True if any IO error occurred. Callers treat this as
   * "unknown" rather than "clear" - a broken scanner must never
   * block arming forever. */
  ioError: boolean;
}

/** Walk a tail buffer backwards, parsing the last non-empty JSONL
 * line, and classify it. Returns `"unknown"` for any failure mode so
 * the caller always has a defined value. Exported for unit test and
 * direct use by callers that already have a tail buffer in hand. */
export function classifyLastEntry(tail: string): LastEntryKind {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (!raw) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(raw);
    } catch {
      // Partial line (mid-write) or invalid JSON. Try the line
      // before. Claude Code writes full JSONL lines atomically so
      // any mid-write partial is always the very last line, never
      // somewhere in the middle.
      continue;
    }

    if (entry.type === "user") return "user";
    if (entry.type === "assistant") {
      const msg = entry.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      if (Array.isArray(content)) {
        const hasToolUse = content.some(
          (p) =>
            typeof p === "object" &&
            p !== null &&
            (p as Record<string, unknown>).type === "tool_use"
        );
        if (hasToolUse) return "assistant-pending";
      }
      return "assistant-done";
    }
    // Other entry types (system, summary, etc.) keep walking.
  }
  return "unknown";
}

/**
 * Scan a range of bytes at the end of `path` starting at `offset`.
 * Caps read size at `MAX_SCAN_BYTES_PER_POLL`. Returns a
 * `ScanOutcome` with the new offset advanced past bytes consumed,
 * minus a one-marker overlap so a marker straddling the end of one
 * poll and the start of the next is still caught.
 *
 * `nextOffset` is `offset` unchanged on any read error so the caller
 * can retry on the next poll.
 */
export function scanForCompactMarker(
  path: string,
  offset: number,
  currentSize: number
): ScanOutcome {
  if (currentSize <= offset) return { found: false, nextOffset: offset };

  const available = currentSize - offset;
  const toRead = Math.min(available, MAX_SCAN_BYTES_PER_POLL);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { found: false, nextOffset: offset };
  }

  try {
    const buf = Buffer.alloc(toRead);
    const bytesRead = readSync(fd, buf, 0, toRead, offset);
    if (bytesRead <= 0) return { found: false, nextOffset: offset };

    const slice = bytesRead === toRead ? buf : buf.subarray(0, bytesRead);
    const found = slice.includes(COMPACT_MARKER);
    // Overlap must be `marker.length - 1`, not the full marker length.
    // Full-length overlap causes a marker sitting exactly at the tail
    // of one scan to be rediscovered on the next poll (its first byte
    // becomes the starting byte of the next read). Using `length - 1`
    // still catches any marker that straddles the boundary while
    // preventing the same marker from matching twice.
    const overlap = Math.min(bytesRead, COMPACT_MARKER.length - 1);
    return { found, nextOffset: offset + bytesRead - overlap };
  } catch {
    return { found: false, nextOffset: offset };
  } finally {
    closeSync(fd);
  }
}

/**
 * One-shot scan of the tail of `path`, returning marker count and
 * the file's mtime age. Used ONLY by the secondary loop-detection
 * path in the preflight resolver - the primary arm gate is the
 * context-fraction check, which does not need any tail scanning
 * at all.
 *
 * Age is derived from file `mtime`, which is fine for this use
 * because loop detection is a backup gate: a false positive is
 * "refuse arm for a few extra seconds" which is harmless. We do
 * NOT extract per-marker timestamps - that work was load-bearing
 * when this scanner was the primary recency signal, but the
 * context gate now owns recency. This scanner exists only to
 * answer "are there two or more compacts in the tail right now?"
 *
 * The scan caps its read at `TAIL_HISTORY_SCAN_BYTES` so the cost
 * is bounded regardless of transcript size. Any IO error returns
 * `ioError: true` and callers treat that as "unknown".
 */
export function scanTailForCompactHistory(path: string): TailHistoryOutcome {
  const empty: TailHistoryOutcome = {
    markerCount: 0,
    mtimeMs: 0,
    lastEntryKind: "unknown",
    ioError: false,
  };

  let size: number;
  let mtimeMs: number;
  try {
    const st = statSync(path);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return { ...empty, ioError: true };
  }

  if (size <= 0) return empty;

  const toRead = Math.min(size, TAIL_HISTORY_SCAN_BYTES);
  const start = size - toRead;

  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { ...empty, ioError: true };
  }

  try {
    const buf = Buffer.alloc(toRead);
    const bytesRead = readSync(fd, buf, 0, toRead, start);
    if (bytesRead <= 0) return empty;

    const slice = bytesRead === toRead ? buf : buf.subarray(0, bytesRead);

    let markerCount = 0;
    let searchFrom = 0;
    while (searchFrom <= slice.length - COMPACT_MARKER.length) {
      const hit = slice.indexOf(COMPACT_MARKER, searchFrom);
      if (hit < 0) break;
      markerCount += 1;
      searchFrom = hit + COMPACT_MARKER.length;
    }

    const lastEntryKind = classifyLastEntry(slice.toString("utf8"));

    // Store the RAW mtime, not a precomputed age. Callers age it
    // at resolve time so a cached outcome ages forward correctly
    // across many ticks even when the transcript stops growing.
    return { markerCount, mtimeMs, lastEntryKind, ioError: false };
  } catch {
    return { ...empty, ioError: true };
  } finally {
    closeSync(fd);
  }
}
