import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../fs/atomicWrite";

/**
 * Pre-allow / un-allow MCP tool names in Claude Code's user-level
 * `~/.claude/settings.json` `permissions.allow` array.
 *
 * The harness prompts the user to confirm every newly registered MCP
 * tool on first use. WAT321 just installed the server; making the
 * user re-authorize each tool is redundant and confusing, so each
 * bridge tier seeds its tool names into the allowlist at install
 * time and removes them at uninstall.
 *
 * Best-effort throughout - parse failures (the file may be JSONC with
 * comments that plain JSON.parse rejects) downgrade to a log line and
 * the user falls back to the standard "allow for this project" dialog
 * on first dispatch. Atomic writes ensure the file is never observed
 * mid-update.
 */

interface MinimalLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

/** Append `toolNames` to `permissions.allow`. Idempotent - already-
 * present entries are skipped. No-op when the file exists but is
 * unparseable; the user falls back to the standard prompt. */
export function preAllowMcpTools(
  toolNames: readonly string[],
  logger: MinimalLogger
): void {
  let settings: ClaudeSettings = {};
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      settings = JSON.parse(
        readFileSync(CLAUDE_SETTINGS_PATH, "utf8")
      ) as ClaudeSettings;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `~/.claude/settings.json parse skipped (${msg}); user will see one-time permission prompt on first call`
      );
      return;
    }
  }

  if (!settings.permissions) settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

  let added = 0;
  for (const tool of toolNames) {
    if (!settings.permissions.allow.includes(tool)) {
      settings.permissions.allow.push(tool);
      added++;
    }
  }
  if (added === 0) return;

  try {
    mkdirSync(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
    const ok = writeFileAtomic(
      CLAUDE_SETTINGS_PATH,
      `${JSON.stringify(settings, null, 2)}\n`
    );
    if (ok) {
      logger.info(
        `pre-allowed ${added} MCP tool(s) in ~/.claude/settings.json`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`~/.claude/settings.json write skipped (${msg})`);
  }
}

/** Remove `toolNames` from `permissions.allow`. Disabling a bridge
 * leaves the user's allowlist exactly as we found it. */
export function unAllowMcpTools(
  toolNames: readonly string[],
  logger: MinimalLogger
): void {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return;
  let settings: ClaudeSettings;
  try {
    settings = JSON.parse(
      readFileSync(CLAUDE_SETTINGS_PATH, "utf8")
    ) as ClaudeSettings;
  } catch {
    return;
  }
  const allow = settings.permissions?.allow;
  if (!Array.isArray(allow)) return;
  const before = allow.length;
  const filtered = allow.filter(
    (t): t is string => typeof t === "string" && !toolNames.includes(t)
  );
  if (filtered.length === before) return;
  if (settings.permissions === undefined) return;
  settings.permissions.allow = filtered;
  try {
    writeFileAtomic(
      CLAUDE_SETTINGS_PATH,
      `${JSON.stringify(settings, null, 2)}\n`
    );
    logger.info(
      `removed ${before - filtered.length} MCP tool entry/entries from ~/.claude/settings.json`
    );
  } catch {
    // best-effort
  }
}
