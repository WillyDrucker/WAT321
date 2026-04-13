import {
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "fs";

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
