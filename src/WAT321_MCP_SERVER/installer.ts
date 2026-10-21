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
import { createOutputChannelLogger } from "../engine/outputChannelLogger";

/**
 * Unified bridge installer. Epic Handshake's enable/disable toggle is
 * the single switch: enable dispatches `wat321.bridge.installUnified`,
 * disable dispatches `wat321.bridge.uninstallUnified`, both internal
 * commands with no palette entry.
 *
 * Install: extract the bin scripts to `~/.wat321/bridge/bin/` with the
 * prod `node_modules/`, sweep dormant `wat321` entries from
 * `~/.claude.json` whose args[0] no longer exists, sweep any existing
 * entry by name so `claude mcp add` can re-register, register with the
 * wsId (and, with a folder open, the workspace path) injected via
 * `--env`, then pre-allow the tool surface in Claude's settings.
 * Project scope with a workspace folder, user scope with the sentinel
 * `default` wsId when VS Code is folderless so that window still gets
 * a working bridge. Uninstall reverses the registration and the
 * pre-allow list. Script extraction lives in `installerScripts`, the
 * `claude mcp` subprocess wrapper and the two sweeps in
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
export async function installUnifiedBridge(
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

  // With a folder open the registration writes to
  // `<workspace>/.claude/settings.json` at project scope - the CLI takes
  // its target from the spawn cwd, so pass the folder explicitly. With
  // no folder open the registration falls back to user scope
  // (`~/.claude/settings.json`) with the sentinel `default` wsId, so a
  // folderless VS Code window still gets a working bridge - state lands
  // at `~/.wat321/clients/default/`. The next time the user opens a
  // folder, project scope wins by Claude Code's normal precedence and
  // the folder gets its own hashed wsId - the leftover user-scope entry
  // gets swept on the next install.
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceCwd = workspaceFolder?.uri.fsPath;
  const wsId = workspaceId();
  const scope: "project" | "user" = workspaceCwd ? "project" : "user";

  sweepStaleClaudeJsonEntries(logger);
  await sweepPriorMcpEntries(logger, workspaceCwd);

  const add = await runClaudeCli(
    [
      "mcp",
      "add",
      "-s",
      scope,
      UNIFIED_MCP_NAME,
      "--env",
      `WAT321_WORKSPACE_ID=${wsId}`,
      ...(workspaceCwd ? ["--env", `WAT321_WORKSPACE_PATH=${workspaceCwd}`] : []),
      "--",
      "node",
      scriptPath,
    ],
    workspaceCwd
  );
  if (add.code !== 0) {
    const msg = `claude mcp add failed (exit ${add.code}): ${add.stderr.trim() || add.stdout.trim()}`;
    logger.error(msg);
    return { ok: false, error: msg };
  }
  logger.info(
    workspaceCwd
      ? `claude mcp add ${UNIFIED_MCP_NAME} succeeded (project scope, wsId=${wsId})`
      : `claude mcp add ${UNIFIED_MCP_NAME} succeeded (user scope, folderless wsId=${wsId})`
  );
  preAllowMcpTools(UNIFIED_ALLOWED_TOOLS, logger);
  // Heal stale allowlist entries from retired bridge tools. The
  // additive preAllow path does not touch entries that no longer
  // ship, so without this sweep an upgrade from a release that
  // seeded a now-retired tool leaves the entry stranded.
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
