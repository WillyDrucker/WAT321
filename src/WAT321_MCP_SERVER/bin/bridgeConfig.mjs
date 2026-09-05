import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./channelLog.mjs";
import { bridgeStateDir } from "./wat321Paths.mjs";

/**
 * The unified bridge config the extension writes on activate and on
 * every settings change: which targets are enabled and the workspace
 * project name. MJS counterpart to `src/shared/bridge/bridgeConfig.ts`.
 * Defaults keep the server loading (so MCP registration succeeds)
 * with zero tools until the user enables something.
 */

export const BRIDGE_CONFIG_PATH = join(bridgeStateDir(), "config.json");
const PROJECT_NAME_FALLBACK = "Workspace";

function readBridgeConfig() {
  try {
    if (!existsSync(BRIDGE_CONFIG_PATH)) return null;
    return JSON.parse(readFileSync(BRIDGE_CONFIG_PATH, "utf8"));
  } catch (err) {
    log("warn", `bridge config unreadable: ${err?.message || String(err)}`);
    return null;
  }
}

export function readEnabledTargets() {
  const cfg = readBridgeConfig();
  return {
    codex: cfg?.enabled?.codex === true,
    opencode: cfg?.enabled?.opencode === true,
    local: cfg?.enabled?.local === true,
  };
}

/** Workspace folder name from the bridge config, "Workspace" when the
 * config is absent or the field is missing. */
function readProjectName() {
  const name = readBridgeConfig()?.projectName;
  return typeof name === "string" && name.trim().length > 0
    ? name.trim()
    : PROJECT_NAME_FALLBACK;
}

/** Standardized session display label. Pattern: `<ProjectName> Epic
 * Handshake Claude-to-<Target> S<n>`. Alias (`S1`, `S2`, ...) stays
 * the routing key, this string is for display only. */
export function formatSessionDisplayName(target, alias) {
  const targetLabel =
    target === "local" ? "Local" : target === "opencode" ? "OpenCode" : target;
  return `${readProjectName()} Epic Handshake Claude-to-${targetLabel} ${alias}`;
}
