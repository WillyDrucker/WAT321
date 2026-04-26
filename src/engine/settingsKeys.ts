import { homedir } from "node:os";
import { join } from "node:path";

/** WAT321's local data directory. Everything WAT321 writes outside
 * of `~/.claude/settings.json` lives here: caches, claims,
 * sentinel, snapshots. Cleared by Reset WAT321. */
export const WAT321_DIR = join(homedir(), ".wat321");

/**
 * Every `wat321.*` setting key in one place. Eliminates the drift
 * hazard of the same string literal appearing in service.ts,
 * resetSettings.ts, workspaceScopeHeal.ts, and extension.ts.
 *
 * All keys are in unprefixed form (used with
 * `getConfiguration("wat321")`). For the full prefixed form
 * (e.g. in `affectsConfiguration`), use `wat321.${SETTING.key}`.
 */
export const SETTING = {
  enableClaude: "enableClaude",
  enableCodex: "enableCodex",
  displayMode: "displayMode",
  statusBarPriority: "statusBarPriority",
  enableHeatmap: "enableHeatmap",
  notificationsMode: "notifications.mode",
  notificationsClaude: "notifications.claude",
  notificationsCodex: "notifications.codex",
  clearAllData: "clearAllData",
  epicHandshakeEnabled: "epicHandshake.enabled",
  epicHandshakeSuppressCodexToasts: "epicHandshake.suppressCodexNotifications",
  epicHandshakeDefaultWaitMode: "epicHandshake.defaultWaitMode",
  /** Sandbox state applied at every bridge `turn/start`. Default
   * `Read-Only`; `Full-Access` opens shell + filesystem write.
   * Codex Defaults picker writes the runtime override flag; tier
   * activate re-syncs the flag from this setting so the user's
   * persistent preference always wins after a VS Code reload. */
  epicHandshakeCodexSandboxDefault: "epicHandshake.codexSandboxDefault",
  /** Codex model slug used as the default for every bridge
   * `turn/start`. Empty string means "use Codex thread / config
   * default" (no override). Codex Defaults picker writes the runtime
   * override flag; tier activate re-syncs from this setting. */
  epicHandshakeCodexModelDefault: "epicHandshake.codexModelDefault",
  /** Codex reasoning effort (low/medium/high/xhigh). Empty string
   * means "use Codex thread / config default". Codex Defaults picker
   * writes the runtime override flag; tier activate re-syncs. */
  epicHandshakeCodexEffortDefault: "epicHandshake.codexEffortDefault",
} as const satisfies Record<string, string>;
