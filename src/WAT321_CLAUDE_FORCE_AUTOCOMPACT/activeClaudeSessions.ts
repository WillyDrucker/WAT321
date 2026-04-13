import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Enumerate active Claude CLI processes by scanning
 * `~/.claude/sessions/*.json`. Used by the arm confirmation dialog to
 * warn the user when multiple Claude windows exist - the auto-compact
 * override is a global env var, so whichever Claude window prompts
 * first gets the compact.
 */

export interface ActiveClaudeSession {
  sessionId: string;
  cwd: string;
}

export function enumerateActiveClaudeSessions(): ActiveClaudeSession[] {
  const sessionsDir = join(homedir(), ".claude", "sessions");
  if (!existsSync(sessionsDir)) return [];

  const out: ActiveClaudeSession[] = [];
  try {
    const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = readFileSync(join(sessionsDir, file), "utf8");
        const entry = JSON.parse(raw) as {
          sessionId?: string;
          cwd?: string;
        };
        if (entry.sessionId && entry.cwd) {
          out.push({ sessionId: entry.sessionId, cwd: entry.cwd });
        }
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
  return out;
}
