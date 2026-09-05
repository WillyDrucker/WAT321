import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeStateDir } from "../../engine/wat321Paths";

/**
 * The unified bridge's config snapshot on disk. `WAT321_MCP_SERVER`
 * writes it on activate and on every settings or workspace-folder
 * change, the MCP runtime reads it per call, and the pickers and
 * tooltips read `projectName` from it for display labels. Not to be
 * confused with the OpenCode Routes config next to it, which carries
 * the serve URL and instance catalog.
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
