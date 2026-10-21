import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeStateDir } from "../../engine/wat321Paths";
import type { SessionTarget } from "./sessionAliases";

/**
 * The unified bridge's config snapshot on disk, and the session display
 * name derived from it. `WAT321_MCP_SERVER` writes the snapshot on
 * activate and on every settings or workspace-folder change, the MCP
 * runtime reads it per call, and the pickers and tooltips read
 * `projectName` from it for display labels. Not to be confused with the
 * OpenCode Routes config next to it, which carries the serve URL and
 * instance catalog.
 */

export const BRIDGE_CONFIG_PATH = join(bridgeStateDir(), "config.json");

/** Fallback when the bridge config is absent (Epic Handshake never
 * activated) or unreadable. Matches the writer's own fallback. */
const PROJECT_NAME_FALLBACK = "Workspace";

/** The bridge config's `projectName` for session titles and labels. */
export function readBridgeProjectName(): string {
  try {
    if (!existsSync(BRIDGE_CONFIG_PATH)) return PROJECT_NAME_FALLBACK;
    const parsed = JSON.parse(readFileSync(BRIDGE_CONFIG_PATH, "utf8")) as {
      projectName?: unknown;
    };
    if (typeof parsed.projectName === "string" && parsed.projectName.trim().length > 0) {
      return parsed.projectName.trim();
    }
    return PROJECT_NAME_FALLBACK;
  } catch {
    return PROJECT_NAME_FALLBACK;
  }
}

/** The display name every surface shares for an OpenCode or Local LLM
 * session: the Epic Handshake pickers, the Routes tooltip, and the
 * bridge response text. Mirrors `formatSessionDisplayName` in
 * `WAT321_MCP_SERVER/bin/bridgeConfig.mjs`, which the runtime uses. */
export function formatSessionDisplayName(target: SessionTarget, alias: string): string {
  const targetLabel = target === "local" ? "Local" : "OpenCode";
  return `${readBridgeProjectName()} Epic Handshake Claude-to-${targetLabel} ${alias}`;
}
