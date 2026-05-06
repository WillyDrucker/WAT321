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
 * Unified bridge installer (v1.4.1+).
 *
 * Manual command-driven for safety while the unified handlers are
 * still minimal v1. The legacy two-server registration (`wat321` for
 * Epic Handshake, `wat321-model-bridge` for Model Bridge) stays live
 * and continues to handle real traffic. Running the install command
 * sweeps both legacy entries AND registers the unified server -
 * after that point, only the unified server is active.
 *
 * Once v1.4.1 ships and validates in real use, the install command
 * call moves to extension activate and the legacy installers go
 * away. For now the manual gate keeps the cutover under user
 * control.
 *
 * Commands registered:
 *   - `wat321.bridge.installUnified`   (sweep legacy + register unified)
 *   - `wat321.bridge.uninstallUnified` (sweep unified, leave legacy alone)
 *
 * The "use unified" flip is bidirectional: a user who wants to roll
 * back from unified to legacy runs the legacy installers' commands
 * (already exist) after this uninstall.
 */

const BRIDGE_DIR = join(homedir(), ".wat321", "bridge");
const BIN_DIR = join(BRIDGE_DIR, "bin");
const UNIFIED_MCP_NAME = "wat321";
const LEGACY_MCP_NAMES = ["wat321", "wat321-model-bridge"] as const;
const SCRIPT_FILES = ["channel.mjs", "codex.mjs", "opencode.mjs"] as const;

const UNIFIED_ALLOWED_TOOLS = [
  "mcp__wat321__wat321_ask",
  "mcp__wat321__wat321_inbox",
  "mcp__wat321__wat321_list",
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

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "wat321.bridge.installUnified",
      async () => {
        const confirm = await vscode.window.showWarningMessage(
          "Install the unified WAT321 bridge? This sweeps the legacy 'wat321' (Epic Handshake) and 'wat321-model-bridge' MCP entries and registers a single 'wat321' entry exposing 4 unified tools (wat321_ask / wat321_inbox / wat321_list / wat321_session). The unified handlers are minimal v1 - some advanced legacy features (adaptive heartbeat, fire-and-forget, harness sub-agents) are not yet ported.",
          { modal: false },
          "Install Unified",
          "Cancel"
        );
        if (confirm !== "Install Unified") return;
        // Set the feature flag FIRST so EH/MB tier reconcileInstall
        // skips its legacy registration on the next activate. Without
        // this, a settings-change-driven re-install after our sweep
        // would re-add the legacy entry.
        const config = vscode.workspace.getConfiguration("wat321");
        try {
          await config.update(
            "bridge.useUnified",
            true,
            vscode.ConfigurationTarget.Global
          );
        } catch {
          // best-effort
        }
        const result = await installUnifiedBridge(context, logger);
        if (result.ok) {
          void vscode.window.showInformationMessage(
            "Unified WAT321 bridge installed. Reload the Claude Code window for new tools to take effect."
          );
        } else {
          // Roll back the flag so legacy installers retake their slots
          // on next activate.
          try {
            await config.update(
              "bridge.useUnified",
              false,
              vscode.ConfigurationTarget.Global
            );
          } catch {
            // best-effort
          }
          void vscode.window.showErrorMessage(
            `Unified bridge install failed: ${result.error}`
          );
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "wat321.bridge.uninstallUnified",
      async () => {
        // Flip the flag BEFORE the uninstall so the next activate's
        // legacy reconcileInstall paths re-register the EH and MB
        // entries automatically. The user gets a clean rollback to
        // the v1.4.0 two-server topology with one command.
        const config = vscode.workspace.getConfiguration("wat321");
        try {
          await config.update(
            "bridge.useUnified",
            false,
            vscode.ConfigurationTarget.Global
          );
        } catch {
          // best-effort
        }
        await uninstallUnifiedBridge(logger);
        void vscode.window.showInformationMessage(
          "Unified WAT321 bridge uninstalled. Reload VS Code to re-register the legacy Epic Handshake + Model Bridge entries."
        );
      }
    )
  );
}
