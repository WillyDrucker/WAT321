import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Atomic single-holder claim file for cross-instance coordination.
 * Only one VS Code window can own the claim at a time. Stale claims
 * (crashed owner) are reclaimed based on either the parseable
 * `acquiredAt` timestamp or the filesystem mtime when the content is
 * corrupt.
 *
 * Extracted out of `Coordinator` so the coordinator class can stay
 * focused on cache reads/writes and per-instance read throttling.
 * The claim logic is pure file I/O over a path - no instance state.
 *
 * Crash-safety notes:
 *
 * Corrupt claim files (zero-byte, partial write, unparseable JSON) are
 * treated as stale if their filesystem mtime is older than `ttlMs`.
 * The main source of a corrupt claim is a crash between
 * `openSync("wx")` and `writeSync(fd, payload)`, which would leave a
 * zero-byte file on disk. Without the mtime fallback, that would
 * deadlock every instance forever because `JSON.parse` throws before
 * the TTL check can run.
 *
 * Note: claim writes go through the owned file descriptor (`writeSync`)
 * rather than reopening the path (`writeFileSync`), so the truncate
 * window that `writeFileSync(path)` would create does not exist here.
 */

/** Try to atomically claim the refresh slot at `claimPath`. Returns
 * `true` if the caller owns the claim, `false` if another instance
 * holds it. Stale claims (> `ttlMs` old by content timestamp or file
 * mtime) are forcibly reclaimed. */
export function tryAcquireClaim(claimPath: string, ttlMs: number): boolean {
  try {
    const dir = dirname(claimPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    return false;
  }

  // Fast path: atomic create, fails if file exists.
  if (writeNewClaim(claimPath)) return true;

  // Parseable claim with a stale acquiredAt timestamp.
  try {
    const json = readFileSync(claimPath, "utf8");
    const claim = JSON.parse(json);
    const acquiredAt =
      typeof claim?.acquiredAt === "number" ? claim.acquiredAt : 0;
    if (Date.now() - acquiredAt > ttlMs) {
      return reclaimStaleClaim(claimPath);
    }
    return false;
  } catch {
    // Unparseable claim. Fall through to the mtime-based check.
  }

  // Corrupt / zero-byte / partial-write claim. Use filesystem mtime as
  // the age signal since we cannot trust the contents.
  try {
    const mtime = statSync(claimPath).mtimeMs;
    if (Date.now() - mtime > ttlMs) {
      return reclaimStaleClaim(claimPath);
    }
  } catch {
    // Cannot even stat the file - assume someone holds it.
  }

  return false;
}

/** Release the claim at `claimPath`. Best-effort. */
export function releaseClaim(claimPath: string): void {
  try {
    rmSync(claimPath, { force: true });
  } catch {
    // best-effort
  }
}

/** Create and write the claim file atomically via `O_EXCL`. Returns
 * `true` on success, `false` if the file already exists. */
function writeNewClaim(claimPath: string): boolean {
  try {
    const fd = openSync(claimPath, "wx");
    try {
      writeSync(fd, JSON.stringify({ acquiredAt: Date.now() }));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/** Delete the current claim file and atomically recreate it. Two
 * instances can enter this path concurrently, but the atomic
 * `openSync("wx")` inside `writeNewClaim` arbitrates - one returns
 * `true`, the other sees `EEXIST` and returns `false` cleanly. */
function reclaimStaleClaim(claimPath: string): boolean {
  try {
    rmSync(claimPath, { force: true });
  } catch {
    return false;
  }
  return writeNewClaim(claimPath);
}
