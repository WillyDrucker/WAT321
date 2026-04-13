import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Session-aware disarm helper. Used by the service poll loop to detect
 * "the Claude terminal owning this arm has exited" before the 45-second
 * timeout, so we can restore settings immediately on the "user closed
 * Claude mid-arm" recovery path.
 */

/** Scan `~/.claude/sessions/*.json` for a live entry whose `sessionId`
 * matches the targeted session. Returns `true` if found. Errs on the
 * side of "still live" if the sessions directory itself cannot be
 * read, so a transient filesystem hiccup does not cause a spurious
 * disarm. */
export function isTargetSessionStillLive(targetSessionId: string): boolean {
  const sessionsDir = join(homedir(), ".claude", "sessions");
  if (!existsSync(sessionsDir)) return false;

  try {
    const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = readFileSync(join(sessionsDir, file), "utf8");
        const entry = JSON.parse(raw) as { sessionId?: string };
        if (entry.sessionId === targetSessionId) return true;
      } catch {
        // skip malformed entries
      }
    }
  } catch {
    return true;
  }
  return false;
}
