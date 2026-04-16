import { homedir } from "node:os";
import { join } from "node:path";

/** WAT321's local data directory. Everything WAT321 writes outside
 * of `~/.claude/settings.json` lives here: caches, claims,
 * sentinel, snapshots. Cleared by Reset WAT321. */
export const WAT321_DIR = join(homedir(), ".wat321");

/**
 * Every `wat321.*` setting key in one place. Eliminates the drift
 * hazard of the same string literal appearing in service.ts,
 * clearSettings.ts, applicationScopeHeal.ts, and extension.ts.
 *
 * All keys are in unprefixed form (used with
 * `getConfiguration("wat321")`). For the full prefixed form
 * (e.g. in `affectsConfiguration`), use `wat321.${SETTING.key}`.
 */
export const SETTING = {
  enableClaude: "enableClaude",
  enableCodex: "enableCodex",
  experimentalAutoCompact: "experimental.forceClaudeAutoCompact",
  displayMode: "displayMode",
  statusBarPriority: "statusBarPriority",
  enableHeatmap: "enableHeatmap",
  clearAllData: "clearAllData",
} as const;
