import {
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";

const DEFAULT_TAIL_BYTES = 262_144;
const DEFAULT_HEAD_BYTES = 8_192;

/**
 * Read the last N bytes of a file. Returns the full file if smaller than
 * the requested tail size. Returns null on any I/O error.
 */
export function readTail(
  path: string,
  bytes: number = DEFAULT_TAIL_BYTES
): string | null {
  try {
    const size = statSync(path).size;
    if (size <= bytes) return readFileSync(path, "utf8");

    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(bytes);
      readSync(fd, buf, 0, bytes, size - bytes);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Read the first N bytes of a file. Returns the full file if smaller than
 * the requested head size. Returns null on any I/O error.
 */
export function readHead(
  path: string,
  bytes: number = DEFAULT_HEAD_BYTES
): string | null {
  try {
    const size = statSync(path).size;
    if (size <= bytes) return readFileSync(path, "utf8");

    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(bytes);
      readSync(fd, buf, 0, bytes, 0);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Read and return the first complete line of a file. Reads in 16KB
 * chunks until a newline is found or the file ends. Safe for rollouts
 * whose `session_meta` first line routinely exceeds 8KB (env dumps,
 * MCP tool listings, git metadata push it to 15-25KB; future Codex
 * versions may grow it further). Capped at `maxBytes` to prevent
 * runaway reads on a malformed file with no newlines. Returns null
 * on I/O error or when no newline appears before `maxBytes`.
 */
export function readFirstLine(
  path: string,
  maxBytes: number = 262_144
): string | null {
  const CHUNK = 16_384;
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(Math.min(CHUNK, maxBytes));
      let accumulated = "";
      let offset = 0;
      while (offset < maxBytes) {
        const toRead = Math.min(buf.length, maxBytes - offset);
        const n = readSync(fd, buf, 0, toRead, offset);
        if (n <= 0) return accumulated.length > 0 ? accumulated : null;
        const chunk = buf.slice(0, n).toString("utf8");
        const newlineIdx = chunk.indexOf("\n");
        if (newlineIdx >= 0) return accumulated + chunk.slice(0, newlineIdx);
        accumulated += chunk;
        offset += n;
        if (n < toRead) return accumulated;
      }
      return null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
