import { closeSync, openSync, readSync } from "node:fs";

/**
 * Detects a Claude auto-compact by scanning appended bytes of the
 * watched transcript for the `"isCompactSummary":true` marker. Claude
 * Code's `.jsonl` transcripts are append-only so file size never drops
 * on compact; byte-level scanning from a rolling offset is the only
 * reliable signal.
 *
 * The experimental tier uses only the rolling `scanForCompactMarker`
 * helper - no preflight tail scanning, no JSONL classification.
 */

export const COMPACT_MARKER = Buffer.from('"isCompactSummary":true');

/** Cap each poll's scan window so a very active session cannot pin
 * us on a giant read. New compact summaries are tiny; 2 MB of fresh
 * bytes per poll is far more than enough. */
export const MAX_SCAN_BYTES_PER_POLL = 2_000_000;

export interface ScanOutcome {
  /** True if the marker was found in the bytes scanned this poll. */
  found: boolean;
  /** Offset to resume scanning from next poll (includes overlap). */
  nextOffset: number;
}

/**
 * Scan a range of bytes at the end of `path` starting at `offset`.
 * Caps read size at `MAX_SCAN_BYTES_PER_POLL`. Returns a `ScanOutcome`
 * with the new offset advanced past bytes consumed, minus a
 * one-marker overlap so a marker straddling the end of one poll and
 * the start of the next is still caught.
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
    // of one scan to be rediscovered on the next poll. Using length-1
    // still catches any marker that straddles the boundary.
    const overlap = Math.min(bytesRead, COMPACT_MARKER.length - 1);
    return { found, nextOffset: offset + bytesRead - overlap };
  } catch {
    return { found: false, nextOffset: offset };
  } finally {
    closeSync(fd);
  }
}
