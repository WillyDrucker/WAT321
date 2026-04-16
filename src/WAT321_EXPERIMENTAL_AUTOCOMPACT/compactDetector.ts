import { closeSync, openSync, readSync, statSync } from "node:fs";
import { classifyLastEntry, type LastEntryKind } from "../WAT321_CLAUDE_SESSION_TOKENS/parsers";

/**
 * Compact-history scanner for the experimental Force Claude Auto-Compact
 * preflight gate. Reads a bounded tail window once, counts
 * `"isCompactSummary":true` markers, and classifies the last parsed
 * JSONL entry. Used by the `recent-compact` and `claude-busy`
 * preflight gates so the tick-time arm check does not have to touch
 * the file more than once.
 */

export const COMPACT_MARKER = Buffer.from('"isCompactSummary":true');

/** Tail window read by `scanTailForCompactHistory`. 256 KB covers
 * several consecutive compact summaries on a busy session while
 * still completing in sub-millisecond time on modern disks. The
 * preflight gate runs at most once per user arm click, so this cost
 * is never in a poll path. */
export const TAIL_HISTORY_SCAN_BYTES = 256_000;

export interface TailHistoryOutcome {
  /** Count of `"isCompactSummary":true` markers in the tail window. */
  markerCount: number;
  /** Wall-clock timestamp (ms since epoch) parsed from the JSONL
   * `timestamp` field of the line containing the *newest* compact
   * marker in the tail window. Zero when no marker was found OR
   * when the marker's containing line could not be parsed for any
   * reason. The recent-compact gate uses this directly so it
   * measures the age of the actual compact event, not the file. */
  newestMarkerTimestampMs: number;
  /** Classification of the last parseable JSONL entry. */
  lastEntryKind: LastEntryKind;
  /** True if any IO error occurred. Gates treat this as "unknown"
   * rather than "blocked" so a broken scanner never prevents
   * arming. */
  ioError: boolean;
}

/**
 * One-shot scan of the transcript tail. Counts compact markers in
 * the last `TAIL_HISTORY_SCAN_BYTES` bytes and classifies the last
 * parseable JSONL entry. Called at most once per user arm click.
 *
 * Any IO error returns `ioError: true` with zero counts and an
 * `unknown` classification - callers must treat IO errors as
 * "cannot confirm blocker" rather than "blocker fired".
 */
export function scanTailForCompactHistory(path: string): TailHistoryOutcome {
  const empty: TailHistoryOutcome = {
    markerCount: 0,
    newestMarkerTimestampMs: 0,
    lastEntryKind: "unknown",
    ioError: false,
  };

  let size: number;
  try {
    size = statSync(path).size;
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

    // Walk the tail and remember every marker hit so the LAST
    // (highest byte position) one can be timestamped after the
    // walk. Counting markers and locating the newest is one pass.
    let markerCount = 0;
    let newestMarkerOffset = -1;
    let searchFrom = 0;
    while (searchFrom <= slice.length - COMPACT_MARKER.length) {
      const hit = slice.indexOf(COMPACT_MARKER, searchFrom);
      if (hit < 0) break;
      markerCount += 1;
      newestMarkerOffset = hit;
      searchFrom = hit + COMPACT_MARKER.length;
    }

    const text = slice.toString("utf8");
    const lastEntryKind = classifyLastEntry(text);
    const newestMarkerTimestampMs =
      newestMarkerOffset >= 0
        ? extractTimestampForOffset(slice, newestMarkerOffset)
        : 0;

    return {
      markerCount,
      newestMarkerTimestampMs,
      lastEntryKind,
      ioError: false,
    };
  } catch {
    return { ...empty, ioError: true };
  } finally {
    closeSync(fd);
  }
}

/** Given the byte offset of a compact marker inside a tail buffer,
 * locate the JSONL line that contains it, parse it, and return the
 * `timestamp` field as ms since epoch. Returns 0 on any failure
 * mode (line straddles the buffer start, JSON parse fails, no
 * timestamp field, unparseable timestamp). The recent-compact gate
 * treats 0 as "no usable signal" and biases toward allowing arming
 * rather than blocking - the cooldown gate is the loop backstop. */
function extractTimestampForOffset(
  slice: Buffer,
  markerOffset: number
): number {
  // Find the start of this line by scanning backward to the
  // preceding newline (or buffer start). If the line straddles the
  // buffer start the JSON will be incomplete and parse will fail -
  // that is fine, we return 0 and let the gate bias toward allow.
  let lineStart = markerOffset;
  while (lineStart > 0 && slice[lineStart - 1] !== 0x0a /* \n */) {
    lineStart -= 1;
  }

  // Find the end of the line by scanning forward to the next newline
  // (or buffer end).
  let lineEnd = markerOffset;
  while (lineEnd < slice.length && slice[lineEnd] !== 0x0a) {
    lineEnd += 1;
  }

  // `.trim()` handles any trailing `\r` on `\r\n` line endings plus
  // any stray whitespace. Claude Code writes LF on POSIX and is
  // expected to do the same on Windows, but trimming costs nothing
  // and removes one class of surprise.
  const lineText = slice.subarray(lineStart, lineEnd).toString("utf8").trim();
  if (!lineText) return 0;

  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(lineText);
  } catch {
    return 0;
  }

  const ts = entry.timestamp;
  if (typeof ts !== "string") return 0;

  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : 0;
}
