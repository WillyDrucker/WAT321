import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type * as vscode from "vscode";
import { atomicCopy } from "../shared/fs/atomicCopy";
import { copyProdModules } from "../shared/mcp/copyProdModules";
import { preAllowMcpTools, unAllowMcpTools } from "../shared/mcp/preAllowTools";
import {
  BIN_DIR,
  CHANNEL_SCRIPT_NAME,
  LEGACY_MCP_SERVER_NAMES,
  MCP_SERVER_NAME,
  MODEL_BRIDGE_DIR,
} from "./constants";
import type { ModelBridgeLogger } from "./outputChannel";

/** Tool names the Model Bridge needs Claude Code to invoke without
 * prompt. Future slices that add tools should append here so they
 * land in the allowlist at install time. */
const BRIDGE_ALLOWED_TOOLS = [
  "mcp__wat321-model-bridge__model_bridge_ask",
  "mcp__wat321-model-bridge__model_bridge_inbox",
  "mcp__wat321-model-bridge__model_bridge_thread",
  "mcp__wat321-model-bridge__model_bridge_task",
  "mcp__wat321-model-bridge__model_bridge_list",
] as const;

/** Allow-list entries from earlier WAT321_MODEL_BRIDGE iterations
 * that used the `wat321-local-llm` server name and `local_llm_*`
 * tool surface. Sweeping these out on every install keeps the user's
 * `~/.claude/settings.json` clean across the rename. */
const LEGACY_ALLOWED_TOOLS = [
  "mcp__wat321-local-llm__local_llm_ask",
  "mcp__wat321-local-llm__local_llm_inbox",
  "mcp__wat321-local-llm__local_llm_thread",
  "mcp__wat321-local-llm__local_llm_task",
] as const;

/**
 * Install / uninstall the Model Bridge MCP server as a registered
 * Claude Code MCP entry. Mirrors `WAT321_EPIC_HANDSHAKE/
 * channelInstaller.ts` shape - we never edit `~/.claude.json`
 * directly, we invoke `claude mcp add/remove` so Claude writes its
 * own state through its own code path with its own trust dialog.
 *
 * Two known-similar helpers (atomicCopy already in shared, runClaudeCli
 * still duplicated below) flagged as future dedup targets - if a third
 * MCP-based tier ever ships, extract `runClaudeCli` to
 * `shared/mcp/claudeCli.ts` at that point.
 */

export interface InstallResult {
  ok: boolean;
  scriptPath: string;
  error?: string;
}

const INSTALLED_SCRIPT_PATH = join(BIN_DIR, CHANNEL_SCRIPT_NAME);

/** Extract channel.mjs from the extension's bundled assets into
 * `~/.wat321/model-bridge/bin/`. Atomic via `atomicCopy` so a Claude
 * Code spawn racing the overwrite cannot read torn bytes. */
export function extractChannelScript(context: vscode.ExtensionContext): string {
  if (!existsSync(MODEL_BRIDGE_DIR)) {
    mkdirSync(MODEL_BRIDGE_DIR, { recursive: true });
  }
  if (!existsSync(BIN_DIR)) {
    mkdirSync(BIN_DIR, { recursive: true });
  }
  // The script lives at `src/WAT321_MODEL_BRIDGE/bin/` and gets
  // copied to `out/WAT321_MODEL_BRIDGE/bin/` via the build's
  // copy-assets step. Ship layout matches.
  const candidates = [
    join(context.extensionPath, "out", "WAT321_MODEL_BRIDGE", "bin", CHANNEL_SCRIPT_NAME),
    join(context.extensionPath, "src", "WAT321_MODEL_BRIDGE", "bin", CHANNEL_SCRIPT_NAME),
  ];
  let source: string | null = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      source = candidate;
      break;
    }
  }
  if (source === null) {
    throw new Error(
      `${CHANNEL_SCRIPT_NAME} not found in any of: ${candidates.join(", ")}`
    );
  }
  atomicCopy(source, INSTALLED_SCRIPT_PATH);
  return INSTALLED_SCRIPT_PATH;
}

/** Run `claude mcp <subcommand> ...`. Same pattern as the Epic
 * Handshake installer - shells out on Windows because the `claude`
 * binary is a `.cmd` shim that can't be exec'd directly. Returns
 * exit code + captured streams for diagnostics. */
function runClaudeCli(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const useShell = process.platform === "win32";
    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: useShell,
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

/** Probe for `claude` CLI availability. Same predicate as Epic
 * Handshake's installer; duplicated so the Model Bridge tier can
 * decide independently whether to attempt registration. */
export async function isClaudeAvailable(): Promise<boolean> {
  const result = await runClaudeCli(["--version"]);
  return result.code === 0;
}

/** Sweep any legacy MCP entry from `LEGACY_MCP_SERVER_NAMES` so the
 * user never ends up with both an old-named and new-named registration
 * advertising overlapping tools. Best-effort - non-zero exits are
 * normal when the entry was never registered or already removed.
 * Always runs before the new entry is added. */
async function sweepLegacyMcpEntries(logger: ModelBridgeLogger): Promise<void> {
  for (const legacyName of LEGACY_MCP_SERVER_NAMES) {
    const result = await runClaudeCli(["mcp", "remove", "-s", "user", legacyName]);
    if (result.code === 0) {
      logger.info(`swept legacy MCP entry '${legacyName}'`);
    }
  }
  unAllowMcpTools(LEGACY_ALLOWED_TOOLS, logger);
}

/**
 * Extract the bundled MCP script + register it with Claude Code.
 * Idempotent: re-running re-extracts the script (catches extension
 * upgrades), sweeps any legacy registration, and re-runs `claude mcp
 * add`, which is itself idempotent for a server name that already
 * exists.
 */
export async function installModelBridge(
  context: vscode.ExtensionContext,
  logger: ModelBridgeLogger
): Promise<InstallResult> {
  let scriptPath: string;
  try {
    scriptPath = extractChannelScript(context);
    logger.info(`channel script extracted to ${scriptPath}`);
    copyProdModules(context, BIN_DIR, logger);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`extractChannelScript failed: ${msg}`);
    return { ok: false, scriptPath: "", error: msg };
  }

  await sweepLegacyMcpEntries(logger);

  const add = await runClaudeCli([
    "mcp",
    "add",
    "-s",
    "user",
    MCP_SERVER_NAME,
    "--",
    "node",
    scriptPath,
  ]);
  if (add.code !== 0) {
    const msg = `claude mcp add failed (exit ${add.code}): ${add.stderr.trim() || add.stdout.trim()}`;
    logger.error(msg);
    return { ok: false, scriptPath, error: msg };
  }
  logger.info(`claude mcp add ${MCP_SERVER_NAME} succeeded`);
  preAllowMcpTools(BRIDGE_ALLOWED_TOOLS, logger);
  return { ok: true, scriptPath };
}

/** Reverse of `installModelBridge`. Best-effort - leaves the user's
 * Claude Code settings exactly as the CLI removes them. */
export async function uninstallModelBridge(
  logger: ModelBridgeLogger
): Promise<void> {
  await sweepLegacyMcpEntries(logger);
  const result = await runClaudeCli([
    "mcp",
    "remove",
    "-s",
    "user",
    MCP_SERVER_NAME,
  ]);
  if (result.code === 0) {
    logger.info(`claude mcp remove ${MCP_SERVER_NAME} succeeded`);
  } else {
    // Non-zero exit is normal when the entry is already absent. Log
    // at info level to avoid alarming the user during fresh installs.
    logger.info(
      `claude mcp remove ${MCP_SERVER_NAME} exited ${result.code} (likely already absent): ${result.stderr.trim() || result.stdout.trim()}`
    );
  }
  unAllowMcpTools(BRIDGE_ALLOWED_TOOLS, logger);
}
