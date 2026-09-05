import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeStateDir, ensureDir } from "./wat321Paths.mjs";

/**
 * Best-effort trace log for the bridge runtime at
 * `<bridgeStateDir>/channel.log`. Bounded: every append is followed by
 * a size check that truncates from the head once the cap is crossed,
 * so a runaway loop cannot fill the disk. Never throws into the MCP
 * loop. SSE-tap failures are silent in the dispatch path, so the
 * `sse` level is the only signal when live tokens fall back to
 * elapsed-seconds.
 */

const LOG_PATH = join(bridgeStateDir(), "channel.log");
const LOG_MAX_BYTES = 50_000;

export function log(level, message) {
  try {
    ensureDir(bridgeStateDir());
    writeFileSync(
      LOG_PATH,
      `[${new Date().toISOString()}] [${level}] ${message}\n`,
      { flag: "a" }
    );
    const current = readFileSync(LOG_PATH, "utf8");
    if (current.length > LOG_MAX_BYTES) {
      writeFileSync(LOG_PATH, current.slice(-LOG_MAX_BYTES));
    }
  } catch {
    // best-effort
  }
}
