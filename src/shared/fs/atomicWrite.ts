import { renameSync, writeFileSync } from "node:fs";

/**
 * Atomic file write via tmp + rename. Readers polling the target file never
 * see torn bytes; either the prior content or the new content, never a
 * half-flushed buffer mid-write.
 *
 * Accepts `string` (written as utf8) or `Buffer` (byte-preserving copy).
 * Returns true on success, false on any failure (caller decides whether to
 * propagate or swallow). On Windows, rename-over-open-file can return EBUSY
 * if another process holds the target - that surfaces as `false`, with the
 * tmp file left in place for any subsequent retry to overwrite.
 */
export function writeFileAtomic(
  target: string,
  content: string | Buffer,
  tmpSuffix: string = ".tmp"
): boolean {
  const tmp = `${target}${tmpSuffix}`;
  try {
    if (typeof content === "string") {
      writeFileSync(tmp, content, "utf8");
    } else {
      writeFileSync(tmp, content);
    }
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}
