import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { atomicCopy } from "../shared/fs/atomicCopy";
import { resolveClaudeCli } from "../shared/mcp/cliBinaryResolver";
import { copyProdModules } from "../shared/mcp/copyProdModules";
import { preAllowMcpTools, unAllowMcpTools } from "../shared/mcp/preAllowTools";
import { createBridgeLogger } from "./outputChannel";

/**
 * Unified bridge installer.
 *
 * Epic Handshake is the single switch for the unified MCP server -
 * EH enable dispatches `wat321.bridge.installUnified`, EH disable
 * dispatches `wat321.bridge.uninstallUnified`. Both commands are
 * internal-only (no command-palette entries) so the user never has
 * to think about MCP installation directly.
 *
 * Install steps:
 *   1. Sweep legacy MCP entries (`wat321` from the previous EH
 *      channel install, plus the retired `wat321-model-bridge` from
 *      pre-1.4.x) so duplicates can't accumulate.
 *   2. Extract `channel.mjs` / `codex.mjs` / `opencode.mjs` to
 *      `~/.wat321/bridge/bin/` and copy `node_modules/` for prod deps.
 *   3. `claude mcp add wat321 -- node ~/.wat321/bridge/bin/channel.mjs`.
 *   4. Pre-allow the unified tool surface in Claude's settings.
 *
 * Uninstall reverses the registration + the pre-allow list.
 */

const BRIDGE_DIR = join(homedir(), ".wat321", "bridge");
const BIN_DIR = join(BRIDGE_DIR, "bin");
const UNIFIED_MCP_NAME = "wat321";
const LEGACY_MCP_NAMES = ["wat321", "wat321-model-bridge"] as const;
const SCRIPT_FILES = ["channel.mjs", "codex.mjs", "opencode.mjs"] as const;

// Tool surface: dispatch + session lifecycle. Inbox / list moved to
// MCP resources, which don't need pre-allowance because resources/read
// is a different permission surface than tool calls.
const UNIFIED_ALLOWED_TOOLS = [
  "mcp__wat321__wat321_ask",
  "mcp__wat321__wat321_session",
] as const;

const LEGACY_ALLOWED_TOOLS = [
  "mcp__wat321__epic_handshake_ask",
  "mcp__wat321__epic_handshake_inbox",
  "mcp__wat321-model-bridge__model_bridge_ask",
  "mcp__wat321-model-bridge__model_bridge_inbox",
  "mcp__wat321-model-bridge__model_bridge_thread",
  "mcp__wat321-model-bridge__model_bridge_task",
  "mcp__wat321-model-bridge__model_bridge_list",
] as const;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface UnifiedLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const consoleLogger: UnifiedLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Run `claude mcp ...` with the resolved Claude CLI path. */
async function runClaudeCli(args: string[]): Promise<CliResult> {
  const resolved = await resolveClaudeCli();
  if (resolved === null) {
    return {
      code: -1,
      stdout: "",
      stderr:
        "claude CLI not found on PATH or in the Claude Code VS Code extension",
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

/** Extract the unified bridge scripts from the extension bundle to
 * `~/.wat321/bridge/bin/`. Atomic via `atomicCopy` so a Claude Code
 * spawn racing the overwrite cannot read torn bytes. Returns the
 * absolute path of the entry script. */
export function extractUnifiedScripts(
  context: vscode.ExtensionContext
): string {
  if (!existsSync(BRIDGE_DIR)) mkdirSync(BRIDGE_DIR, { recursive: true });
  if (!existsSync(BIN_DIR)) mkdirSync(BIN_DIR, { recursive: true });

  const subdirs = ["out", "src"] as const;
  for (const fileName of SCRIPT_FILES) {
    let source: string | null = null;
    for (const subdir of subdirs) {
      const candidate = join(
        context.extensionPath,
        subdir,
        "WAT321_BRIDGE",
        "bin",
        fileName
      );
      if (existsSync(candidate)) {
        source = candidate;
        break;
      }
    }
    if (source === null) {
      throw new Error(
        `unified bridge script ${fileName} not found in extension bundle`
      );
    }
    atomicCopy(source, join(BIN_DIR, fileName));
  }
  return join(BIN_DIR, "channel.mjs");
}

/** Sweep legacy MCP entries via `claude mcp remove`. Best-effort -
 * non-zero exits are normal when the entry was never registered. */
async function sweepLegacy(logger: UnifiedLogger): Promise<void> {
  for (const legacyName of LEGACY_MCP_NAMES) {
    const result = await runClaudeCli([
      "mcp",
      "remove",
      "-s",
      "user",
      legacyName,
    ]);
    if (result.code === 0) {
      logger.info(`swept legacy MCP entry '${legacyName}'`);
    }
  }
  unAllowMcpTools(LEGACY_ALLOWED_TOOLS, logger);
}

/** Install the unified bridge: extract scripts, sweep legacy entries,
 * register the new MCP entry, pre-allow new tool names. */
export async function installUnifiedBridge(
  context: vscode.ExtensionContext,
  logger: UnifiedLogger = consoleLogger
): Promise<{ ok: boolean; error?: string; scriptPath?: string }> {
  let scriptPath: string;
  try {
    scriptPath = extractUnifiedScripts(context);
    logger.info(`unified bridge scripts extracted to ${BIN_DIR}`);
    copyProdModules(context, BIN_DIR, logger);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`extractUnifiedScripts failed: ${msg}`);
    return { ok: false, error: msg };
  }

  await sweepLegacy(logger);

  const add = await runClaudeCli([
    "mcp",
    "add",
    "-s",
    "user",
    UNIFIED_MCP_NAME,
    "--",
    "node",
    scriptPath,
  ]);
  if (add.code !== 0) {
    const msg = `claude mcp add failed (exit ${add.code}): ${add.stderr.trim() || add.stdout.trim()}`;
    logger.error(msg);
    return { ok: false, error: msg };
  }
  logger.info(`claude mcp add ${UNIFIED_MCP_NAME} succeeded`);
  preAllowMcpTools(UNIFIED_ALLOWED_TOOLS, logger);
  return { ok: true, scriptPath };
}

/** Uninstall the unified bridge. Does NOT re-register the legacy
 * servers - users who want to roll back run the legacy installers'
 * commands explicitly. */
export async function uninstallUnifiedBridge(
  logger: UnifiedLogger = consoleLogger
): Promise<void> {
  const result = await runClaudeCli([
    "mcp",
    "remove",
    "-s",
    "user",
    UNIFIED_MCP_NAME,
  ]);
  if (result.code === 0) {
    logger.info(`claude mcp remove ${UNIFIED_MCP_NAME} succeeded`);
  } else {
    logger.info(
      `claude mcp remove ${UNIFIED_MCP_NAME} exited ${result.code} (likely already absent)`
    );
  }
  unAllowMcpTools(UNIFIED_ALLOWED_TOOLS, logger);
}

/** Register the install / uninstall commands. Called from extension
 * activate. */
export function registerUnifiedBridgeCommands(
  context: vscode.ExtensionContext
): void {
  const { logger, channel } = createBridgeLogger();
  context.subscriptions.push(channel);

  // Internal-only commands - dispatched by Epic Handshake on enable /
  // disable. Not contributed to the command palette (the palette
  // contributions were removed when EH became the single switch).
  // Idempotent so a second install/uninstall in a row is a no-op.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "wat321.bridge.installUnified",
      async () => {
        const result = await installUnifiedBridge(context, logger);
        if (!result.ok) {
          throw new Error(result.error || "unified bridge install failed");
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "wat321.bridge.uninstallUnified",
      async () => {
        await uninstallUnifiedBridge(logger);
      }
    )
  );
}
