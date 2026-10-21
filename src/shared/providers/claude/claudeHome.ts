import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code's own state under `~/.claude/`. WAT321 reads these paths
 * on every poll and writes only `settings.json`, where the installer
 * pre-allows the bridge tools.
 */

export const CLAUDE_HOME_DIR = join(homedir(), ".claude");
/** OAuth token the usage service sends to the Anthropic usage endpoint. */
export const CLAUDE_CREDENTIALS_PATH = join(CLAUDE_HOME_DIR, ".credentials.json");
/** User settings: the `env` block with the auto-compact overrides and
 * the `permissions.allow` list the installer maintains. */
export const CLAUDE_SETTINGS_PATH = join(CLAUDE_HOME_DIR, "settings.json");
/** One JSON file per live CLI process with its cwd and session id. */
export const CLAUDE_SESSIONS_DIR = join(CLAUDE_HOME_DIR, "sessions");
/** Transcripts, one `.jsonl` per session under the project key. */
export const CLAUDE_PROJECTS_DIR = join(CLAUDE_HOME_DIR, "projects");
