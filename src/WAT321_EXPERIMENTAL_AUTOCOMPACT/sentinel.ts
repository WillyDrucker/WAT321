import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { WAT321_DIR } from "../engine/settingsKeys";
import type { ExperimentalAutoCompactSentinel } from "./types";

/**
 * Sentinel file IO. The sentinel lives at
 * `~/.wat321/claude-force-auto-compact-sentinel.json` and is the only
 * on-disk record of an in-flight arm. Small and synchronous so the
 * crash-recovery paths in heal.ts can use them without fear of partial
 * writes - every write goes through tmp+rename.
 */

export const SENTINEL_PATH = join(
  WAT321_DIR,
  "claude-force-auto-compact-sentinel.json"
);

export function readSentinel(): ExperimentalAutoCompactSentinel | null {
  if (!existsSync(SENTINEL_PATH)) return null;
  try {
    const raw = readFileSync(SENTINEL_PATH, "utf8");
    const parsed = JSON.parse(raw) as ExperimentalAutoCompactSentinel;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeSentinel(
  sentinel: ExperimentalAutoCompactSentinel
): boolean {
  try {
    mkdirSync(WAT321_DIR, { recursive: true });
    const tmp = `${SENTINEL_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(sentinel, null, 2), "utf8");
    renameSync(tmp, SENTINEL_PATH);
    return true;
  } catch {
    return false;
  }
}

export function deleteSentinel(): void {
  try {
    if (existsSync(SENTINEL_PATH)) unlinkSync(SENTINEL_PATH);
  } catch {
    // best-effort
  }
}
