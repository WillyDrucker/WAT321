import { spawn } from "node:child_process";
import { resolveClaudeCli } from "../shared/mcp/cliBinaryResolver";
import { unAllowMcpTools } from "../shared/mcp/preAllowTools";
import { LEGACY_MCP_SERVER_NAMES, MCP_SERVER_NAME } from "./constants";
import type { ModelBridgeLogger } from "./outputChannel";

/**
 * Sweep the legacy `wat321-model-bridge` MCP entry from
 * `~/.claude/settings.json` on every Model Bridge enable. The unified
 * `wat321` server installed by the bridge tier handles all dispatch
 * now, so this tier only needs to clean up after itself - the
 * `installModelBridge` flow was retired in v1.4.x along with the
 * bundled `channel.mjs` script that backed it.
 */

const LEGACY_ALLOWED_TOOLS = [
  "mcp__wat321-model-bridge__model_bridge_ask",
  "mcp__wat321-model-bridge__model_bridge_inbox",
  "mcp__wat321-model-bridge__model_bridge_thread",
  "mcp__wat321-model-bridge__model_bridge_task",
  "mcp__wat321-model-bridge__model_bridge_list",
  "mcp__wat321-local-llm__local_llm_ask",
  "mcp__wat321-local-llm__local_llm_inbox",
  "mcp__wat321-local-llm__local_llm_thread",
  "mcp__wat321-local-llm__local_llm_task",
] as const;

async function runClaudeCli(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const resolved = await resolveClaudeCli();
  if (resolved === null) {
    return {
      code: -1,
      stdout: "",
      stderr: "claude CLI not found on PATH or in the Claude Code VS Code extension",
    };
  }
  return new Promise((resolve) => {
    const child = spawn(resolved.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: resolved.needsShell,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", (err) => {
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on("exit", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Sweep the current MB MCP entry plus any legacy-named entries
 * (`wat321-model-bridge`, `wat321-local-llm`) so the user never ends
 * up with stale registrations advertising overlapping tools. Best-
 * effort: non-zero exits are normal when the entry was never
 * registered or already removed. */
export async function uninstallModelBridge(
  logger: ModelBridgeLogger
): Promise<void> {
  for (const name of [MCP_SERVER_NAME, ...LEGACY_MCP_SERVER_NAMES]) {
    const result = await runClaudeCli(["mcp", "remove", "-s", "user", name]);
    if (result.code === 0) {
      logger.info(`swept MCP entry '${name}'`);
    }
  }
  unAllowMcpTools(LEGACY_ALLOWED_TOOLS, logger);
}
