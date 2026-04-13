import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeForceAutoCompactSentinel } from "./types";

/**
 * Sentinel file IO. The sentinel lives at
 * `~/.wat321/claude-force-auto-compact-sentinel.json` and is the only
 * on-disk record of an in-flight arm. These helpers are deliberately
 * small and synchronous so crash-recovery paths can use them without
 * fear of partial writes - all writes go through tmp+rename.
 */

export const SENTINEL_PATH = join(
  homedir(),
  ".wat321",
  "claude-force-auto-compact-sentinel.json"
);

/** Read and parse the sentinel. Returns `null` if absent, unreadable,
 * or has a mismatched `version`. */
export function readSentinel(): ClaudeForceAutoCompactSentinel | null {
  if (!existsSync(SENTINEL_PATH)) return null;
  try {
    const raw = readFileSync(SENTINEL_PATH, "utf8");
    const parsed = JSON.parse(raw) as ClaudeForceAutoCompactSentinel;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Atomic tmp+rename writer. Creates `~/.wat321/` if missing. */
export function writeSentinel(
  sentinel: ClaudeForceAutoCompactSentinel
): boolean {
  try {
    mkdirSync(join(homedir(), ".wat321"), { recursive: true });
    const tmp = `${SENTINEL_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(sentinel, null, 2), "utf8");
    renameSync(tmp, SENTINEL_PATH);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort delete. Never throws. */
export function deleteSentinel(): void {
  try {
    if (existsSync(SENTINEL_PATH)) unlinkSync(SENTINEL_PATH);
  } catch {
    // best-effort
  }
}
