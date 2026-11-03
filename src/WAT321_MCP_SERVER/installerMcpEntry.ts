import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../engine/fs/atomicWrite";
import { UNIFIED_MCP_NAME } from "./installerScripts";

/**
 * The bridge's MCP entry, built the way `claude mcp add` writes it. The
 * project entry is written in place with one atomic rename, because a
 * CLI remove-then-add leaves a gap where a starting Claude session loads
 * its MCP config without the bridge and never picks it up.
 */

interface UnifiedMcpEntry {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** `current` means the matching entry was left untouched. `failed`
 * covers a `.mcp.json` that is not a JSON object or cannot be replaced. */
type ProjectEntryResult = "current" | "written" | "failed";

const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 50;

export function unifiedMcpEntry(
  scriptPath: string,
  wsId: string,
  workspaceCwd: string | undefined
): UnifiedMcpEntry {
  const env: Record<string, string> = { WAT321_WORKSPACE_ID: wsId };
  if (workspaceCwd) env.WAT321_WORKSPACE_PATH = workspaceCwd;
  return { type: "stdio", command: "node", args: [scriptPath], env };
}

/** Write the entry into `<workspace>/.mcp.json`, keeping every other
 * server and key, so a reader sees the old entry or the new one and
 * never neither. A routine activation finds it current and writes
 * nothing. */
export async function writeProjectEntry(
  workspaceCwd: string,
  entry: UnifiedMcpEntry
): Promise<ProjectEntryResult> {
  const path = join(workspaceCwd, ".mcp.json");
  const config = existsSync(path) ? readJsonObject(path) : {};
  if (config === null) return "failed";
  const servers = config.mcpServers ?? {};
  if (!isObject(servers)) return "failed";
  if (sameEntry(servers[UNIFIED_MCP_NAME], entry)) return "current";
  config.mcpServers = { ...servers, [UNIFIED_MCP_NAME]: entry };
  const content = JSON.stringify(config, null, 2);
  // Windows refuses a rename onto a file another process is reading, so
  // a Claude session loading its config at that instant costs a retry.
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RENAME_RETRY_MS));
    if (writeFileAtomic(path, content)) return "written";
  }
  try {
    unlinkSync(`${path}.tmp`);
  } catch {
    // the tmp file was never written
  }
  return "failed";
}

/** True when `~/.claude.json` already holds the entry at user scope. */
export function isUserEntryCurrent(entry: UnifiedMcpEntry): boolean {
  const servers = readJsonObject(join(homedir(), ".claude.json"))?.mcpServers;
  return isObject(servers) && sameEntry(servers[UNIFIED_MCP_NAME], entry);
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Key order follows the CLI's, so an entry it wrote compares equal. */
function sameEntry(existing: unknown, entry: UnifiedMcpEntry): boolean {
  return JSON.stringify(existing) === JSON.stringify(entry);
}
