import * as vscode from "vscode";
import { copyProdModules } from "./installerProdModules";
import {
  healLegacyAllowlistEntries,
  preAllowMcpTools,
  unAllowMcpTools,
} from "../shared/providers/claude/mcpAllowlist";
import { workspaceId } from "../engine/wat321Paths";
import {
  runClaudeCli,
  silentLogger,
  sweepPriorMcpEntries,
  sweepStaleClaudeJsonEntries,
  type UnifiedLogger,
} from "./installerClaudeCli";
import {
  BRIDGE_BIN_DIR,
  extractUnifiedScripts,
  UNIFIED_MCP_NAME,
} from "./installerScripts";
import {
  isUserEntryCurrent,
  unifiedMcpEntry,
  writeProjectEntry,
} from "./installerMcpEntry";
import { createOutputChannelLogger } from "../engine/outputChannelLogger";

/**
 * Unified bridge installer. Epic Handshake's enable/disable toggle is
 * the single switch: enable dispatches `wat321.bridge.installUnified`,
 * disable dispatches `wat321.bridge.uninstallUnified`, both internal
 * commands with no palette entry.
 *
 * Install: extract the bin scripts to `~/.wat321/bridge/bin/` with the
 * prod `node_modules/`, sweep dormant `wat321` entries from
 * `~/.claude.json`, register the entry with the wsId (and, with a
 * folder open, the workspace path) in its env, then pre-allow the tool
 * surface in Claude's settings. Registration never removes a live entry
 * first, see `installerMcpEntry`. Uninstall reverses the registration
 * and the pre-allow list. Script extraction lives in `installerScripts`,
 * the `claude mcp` subprocess wrapper and the two sweeps in
 * `installerClaudeCli`.
 */

// The tool surface pre-allowed in Claude settings. Read-only state
// ships as MCP resources instead, which need no pre-allowance because
// `resources/read` is a different permission surface than tool calls.
const UNIFIED_ALLOWED_TOOLS = [
  "mcp__wat321__wat321_ask",
  "mcp__wat321__wat321_session",
  "mcp__wat321__wat321_bridge",
] as const;

/** Install the unified bridge: extract scripts, sweep legacy entries,
 * register the new MCP entry, pre-allow new tool names. */
async function installUnifiedBridge(
  context: vscode.ExtensionContext,
  logger: UnifiedLogger = silentLogger
): Promise<{ ok: boolean; error?: string; scriptPath?: string }> {
  let scriptPath: string;
  try {
    scriptPath = extractUnifiedScripts(context);
    logger.info(`unified bridge scripts extracted to ${BRIDGE_BIN_DIR}`);
    copyProdModules(context, BRIDGE_BIN_DIR, logger);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`extractUnifiedScripts failed: ${msg}`);
    return { ok: false, error: msg };
  }

  // With a folder open the entry lives in `<workspace>/.mcp.json` at
  // project scope. With no folder open it falls back to user scope in
  // `~/.claude.json` with the sentinel `default` wsId, so a folderless
  // window still gets a working bridge. Project scope wins once a folder
  // opens, and the leftover user-scope entry is swept on that install.
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceCwd = workspaceFolder?.uri.fsPath;
  const wsId = workspaceId();
  const scope: "project" | "user" = workspaceCwd ? "project" : "user";
  const entry = unifiedMcpEntry(scriptPath, wsId, workspaceCwd);

  sweepStaleClaudeJsonEntries(logger);
  if (workspaceCwd) {
    const project = await writeProjectEntry(workspaceCwd, entry);
    if (project !== "failed") {
      logger.info(`${UNIFIED_MCP_NAME} entry in .mcp.json ${project} (wsId=${wsId})`);
      // No cwd, so only a leftover user-scope entry is swept.
      await sweepPriorMcpEntries(logger);
      return finishInstall(scriptPath, logger);
    }
    logger.warn(".mcp.json is unreadable or locked, registering through the claude CLI");
  } else if (isUserEntryCurrent(entry)) {
    logger.info(`${UNIFIED_MCP_NAME} user-scope entry current (folderless wsId=${wsId})`);
    return finishInstall(scriptPath, logger);
  }

  await sweepPriorMcpEntries(logger, workspaceCwd);
  const add = await runClaudeCli(
    [
      "mcp",
      "add",
      "-s",
      scope,
      UNIFIED_MCP_NAME,
      ...Object.entries(entry.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--",
      entry.command,
      ...entry.args,
    ],
    workspaceCwd
  );
  if (add.code !== 0) {
    const msg = `claude mcp add failed (exit ${add.code}): ${add.stderr.trim() || add.stdout.trim()}`;
    logger.error(msg);
    return { ok: false, error: msg };
  }
  logger.info(`claude mcp add ${UNIFIED_MCP_NAME} succeeded (${scope} scope, wsId=${wsId})`);
  return finishInstall(scriptPath, logger);
}

/** Pre-allow the tool surface, then heal allowlist entries for retired
 * bridge tools, which the additive pre-allow never removes. */
function finishInstall(
  scriptPath: string,
  logger: UnifiedLogger
): { ok: boolean; scriptPath: string } {
  preAllowMcpTools(UNIFIED_ALLOWED_TOOLS, logger);
  healLegacyAllowlistEntries(logger);
  return { ok: true, scriptPath };
}

/** Uninstall the unified bridge. Sweeps both project-scope (the
 * folder-mode registration) and user-scope (the folderless-mode
 * registration plus any defensive sweep target). */
export async function uninstallUnifiedBridge(
  logger: UnifiedLogger = silentLogger
): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceCwd = workspaceFolder?.uri.fsPath;
  if (workspaceCwd) {
    const proj = await runClaudeCli(
      ["mcp", "remove", "-s", "project", UNIFIED_MCP_NAME],
      workspaceCwd
    );
    if (proj.code === 0) {
      logger.info(`claude mcp remove ${UNIFIED_MCP_NAME} (project) succeeded`);
    }
  }
  const usr = await runClaudeCli([
    "mcp",
    "remove",
    "-s",
    "user",
    UNIFIED_MCP_NAME,
  ]);
  if (usr.code === 0) {
    logger.info(`claude mcp remove ${UNIFIED_MCP_NAME} (user) succeeded`);
  }
  unAllowMcpTools(UNIFIED_ALLOWED_TOOLS, logger);
}

/** Register the install / uninstall commands. Called from extension
 * activate. */
export function registerUnifiedBridgeCommands(
  context: vscode.ExtensionContext
): void {
  const logger = createOutputChannelLogger("WAT321: Bridge");
  context.subscriptions.push(logger);

  // Internal-only commands - dispatched by Epic Handshake on enable /
  // disable. Not contributed to the command palette. Idempotent so a
  // second install/uninstall in a row is a no-op.
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

  // Refresh-only: re-extract the bin scripts + docs to
  // `~/.wat321/bridge/bin/` without copying node_modules or re-running
  // the MCP registration. Dispatched on every Epic Handshake activate
  // so an extension upgrade reaches users who ALREADY have EH enabled.
  // Install re-extracts only on the explicit enable toggle, so without
  // this an already-enabled user keeps the prior release's bridge until
  // they toggle EH off and on. Best-effort: a failed refresh leaves
  // whatever is on disk, no worse than before.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "wat321.bridge.refreshUnifiedScripts",
      () => {
        try {
          extractUnifiedScripts(context);
          logger.info("unified bridge scripts refreshed on activate");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`unified bridge script refresh failed: ${msg}`);
        }
      }
    )
  );
}
