import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openCodeRoutesStateDir } from "../../engine/wat321Paths";

/**
 * The OpenCode Routes config the Routes tier writes on every settings
 * change, read back as the subset the other tiers need: the live
 * `opencode serve` URL, the active instance, and the instance
 * catalog. The MCP runtime reads the same file per call. The full
 * write-side shape (API keys, retention) lives with the writer in
 * `WAT321_OPENCODE_ROUTES/openCodeRoutesConfig.ts`. Not to be confused
 * with the unified bridge config next to it in `bridgeConfig.ts`.
 */

export const OPENCODE_ROUTES_CONFIG_PATH = join(openCodeRoutesStateDir(), "config.json");

export interface OpenCodeRoutesInstance {
  id: string;
  alias: string;
  kind: "local" | "remote";
  model: string;
  harnessProviderID: "llama.cpp" | "zen";
}

export interface OpenCodeRoutesConfigSnapshot {
  openCodeServerUrl?: string;
  activeInstanceId?: string;
  instances?: OpenCodeRoutesInstance[];
}

/** Null when the Routes tier has not written the file yet or it is
 * unreadable mid-write. */
export function readOpenCodeRoutesConfigSnapshot(): OpenCodeRoutesConfigSnapshot | null {
  if (!existsSync(OPENCODE_ROUTES_CONFIG_PATH)) return null;
  try {
    return JSON.parse(
      readFileSync(OPENCODE_ROUTES_CONFIG_PATH, "utf8")
    ) as OpenCodeRoutesConfigSnapshot;
  } catch {
    return null;
  }
}
