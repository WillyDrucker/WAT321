import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import * as vscode from "vscode";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { atomicCopy } from "../shared/fs/atomicCopy";
import { resolveClaudeCli } from "../shared/providers/claude/cliResolver";
import {
  preAllowMcpTools,
  unAllowMcpTools,
} from "../shared/providers/claude/mcpAllowlist";
import { copyProdModules } from "../shared/mcp/copyProdModules";
import { workspaceId } from "../shared/wat321Paths";
import { createBridgeLogger } from "./outputChannel";

/**
 * Unified bridge installer. Epic Handshake's enable/disable toggle is
 * the single switch: EH enable dispatches
 * `wat321.bridge.installUnified`, EH disable dispatches
 * `wat321.bridge.uninstallUnified`. Both commands are internal-only -
 * no command palette entries, so the user never thinks about MCP
 * registration directly.
 *
 * Install:
 *   1. Extract bin scripts to `~/.wat321/bridge/bin/` and copy
 *      `node_modules/` for prod deps.
 *   2. Sweep dormant `wat321` entries from `~/.claude.json`'s
 *      projects tree whose args[0] points at a path that no longer
 *      exists (artifacts from an earlier registration mechanism).
 *   3. Sweep any existing MCP entry by name so `claude mcp add` can
 *      re-register without duplicate-name errors.
 *   4. Register the MCP entry with the wsId injected via `--env`.
 *      Project scope when a workspace folder is open; user scope with
 *      the sentinel `default` wsId when VS Code is folderless, so a
 *      window with no folder still gets a working bridge.
 *   5. Pre-allow the unified tool surface in Claude's settings.
 *
 * Uninstall reverses the registration plus the pre-allow list.
 */

const BRIDGE_DIR = join(homedir(), ".wat321", "bridge");
const BIN_DIR = join(BRIDGE_DIR, "bin");
const UNIFIED_MCP_NAME = "wat321";
// Defensive user-scope sweep before re-registering at project scope.
// `claude mcp add` errors on duplicate-name rather than overwriting,
// and an earlier install path wrote the entry at user scope - if any
// install still has that, the project-scope add would fail until the
// user-scope entry is gone.
const USER_SCOPE_SWEEP_NAMES = [UNIFIED_MCP_NAME] as const;
const TOP_LEVEL_SCRIPTS = [
  "bridgeInbox.mjs",
  "channel.mjs",
  "codex.mjs",
  "paths.mjs",
  "replyDecorator.mjs",
  "resources.mjs",
] as const;
const OPENCODE_SUBDIR_SCRIPTS = [
  "common.mjs",
  "aliases.mjs",
  "config.mjs",
  "heartbeat.mjs",
  "sse.mjs",
  "sessions.mjs",
  "dispatch.mjs",
  "index.mjs",
] as const;
/** Markdown docs loaded as MCP resources (bridge://docs/*). Kept as
 * separate files instead of string literals so the source is editable
 * markdown and the per-turn tool description budget stays lean - the
 * docs only land in Claude's context when Claude explicitly reads the
 * resource URI. */
const DOCS_SUBDIR_FILES = [
  "dispatch.md",
  "dispatch-errors.md",
  "dispatch-routing.md",
  "dispatch-judgement.md",
  "inbox.md",
] as const;

// Tool surface: dispatch + session lifecycle + inbox consume. Inbox
// peek and other read-only state moved to MCP resources, which don't
// need pre-allowance because resources/read is a different permission
// surface than tool calls.
const UNIFIED_ALLOWED_TOOLS = [
  "mcp__wat321__wat321_ask",
  "mcp__wat321__wat321_session",
  "mcp__wat321__wat321_bridge",
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

/** Run `claude mcp ...` with the resolved Claude CLI path. Pass `cwd`
 * for project-scope operations - the CLI reads the working directory
 * to know which workspace's `.claude/settings.json` to mutate. */
async function runClaudeCli(args: string[], cwd?: string): Promise<CliResult> {
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
      cwd,
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
  const opencodeBinDir = join(BIN_DIR, "opencode");
  if (!existsSync(opencodeBinDir)) mkdirSync(opencodeBinDir, { recursive: true });
  const docsBinDir = join(BIN_DIR, "docs");
  if (!existsSync(docsBinDir)) mkdirSync(docsBinDir, { recursive: true });

  const subdirs = ["out", "src"] as const;
  const copyOne = (relParts: string[], fileName: string, destDir: string) => {
    let source: string | null = null;
    for (const subdir of subdirs) {
      const candidate = join(
        context.extensionPath,
        subdir,
        "WAT321_MCP_SERVER",
        "bin",
        ...relParts,
        fileName
      );
      if (existsSync(candidate)) {
        source = candidate;
        break;
      }
    }
    if (source === null) {
      throw new Error(
        `unified bridge script ${[...relParts, fileName].join("/")} not found in extension bundle`
      );
    }
    atomicCopy(source, join(destDir, fileName));
  };

  for (const fileName of TOP_LEVEL_SCRIPTS) {
    copyOne([], fileName, BIN_DIR);
  }
  for (const fileName of OPENCODE_SUBDIR_SCRIPTS) {
    copyOne(["opencode"], fileName, opencodeBinDir);
  }
  for (const fileName of DOCS_SUBDIR_FILES) {
    copyOne(["docs"], fileName, docsBinDir);
  }
  return join(BIN_DIR, "channel.mjs");
}

/** Strip dormant `wat321` MCP entries from `~/.claude.json`'s
 * per-project `mcpServers` map when their args[0] does not match the
 * current bin path. Claude Code reads project-scope MCP from each
 * workspace's `.mcp.json`; the entries under `~/.claude.json`
 * `projects.X.mcpServers.wat321` are dormant artifacts from an
 * earlier registration mechanism that point at a path which no
 * longer exists. Harmless but accumulating - sweep once on every
 * install so the user-wide config stays clean. */
function sweepStaleClaudeJsonEntries(logger: UnifiedLogger): void {
  const claudeJsonPath = join(homedir(), ".claude.json");
  if (!existsSync(claudeJsonPath)) return;
  let raw: string;
  try {
    raw = readFileSync(claudeJsonPath, "utf8");
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const expected = normalize(join(BIN_DIR, "channel.mjs")).toLowerCase();

  const root = parsed as { projects?: Record<string, unknown> };
  const projects = root.projects;
  if (typeof projects !== "object" || projects === null) return;

  let stripped = 0;
  for (const projectKey of Object.keys(projects)) {
    const project = projects[projectKey];
    if (typeof project !== "object" || project === null) continue;
    const servers = (project as { mcpServers?: Record<string, unknown> })
      .mcpServers;
    if (typeof servers !== "object" || servers === null) continue;
    const entry = servers[UNIFIED_MCP_NAME];
    if (typeof entry !== "object" || entry === null) continue;
    const args = (entry as { args?: unknown }).args;
    if (!Array.isArray(args) || args.length === 0) continue;
    const arg0 = typeof args[0] === "string" ? args[0] : "";
    if (normalize(arg0).toLowerCase() === expected) continue;
    delete servers[UNIFIED_MCP_NAME];
    stripped++;
  }

  if (stripped === 0) return;
  try {
    writeFileAtomic(claudeJsonPath, `${JSON.stringify(parsed, null, 2)}\n`);
    logger.info(
      `swept ${stripped} stale wat321 entry/entries from ~/.claude.json projects tree`
    );
  } catch {
    // best-effort - dormant entries are inert; next install retries
  }
}

/** Sweep prior MCP entries via `claude mcp remove` before re-adding.
 * Required because `claude mcp add` errors on duplicate-name rather
 * than overwriting. Best-effort - non-zero exits are normal when the
 * entry was never registered. */
async function sweepBeforeAdd(
  logger: UnifiedLogger,
  workspaceCwd?: string
): Promise<void> {
  for (const name of USER_SCOPE_SWEEP_NAMES) {
    const result = await runClaudeCli([
      "mcp",
      "remove",
      "-s",
      "user",
      name,
    ]);
    if (result.code === 0) {
      logger.info(`swept user-scope MCP entry '${name}'`);
    }
  }
  if (workspaceCwd) {
    const proj = await runClaudeCli(
      ["mcp", "remove", "-s", "project", UNIFIED_MCP_NAME],
      workspaceCwd
    );
    if (proj.code === 0) {
      logger.info(`swept project-scope MCP entry '${UNIFIED_MCP_NAME}'`);
    }
  }
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

  // Resolve the workspace folder + per-client wsId. With a folder open
  // the registration writes to `<workspace>/.claude/settings.json` at
  // project scope; the CLI takes its target from the spawn cwd, so pass
  // the folder explicitly. With no folder open the registration falls
  // back to user scope (`~/.claude/settings.json`) with the sentinel
  // `default` wsId, so a folderless VS Code window still gets a working
  // bridge - state lands at `~/.wat321/clients/default/`. The next time
  // the user opens a folder, project-scope wins by Claude Code's normal
  // precedence and that folder gets its own hashed wsId; the leftover
  // user-scope entry is swept on the next install (sweepLegacy already
  // covers the unified `wat321` name in user scope).
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceCwd = workspaceFolder?.uri.fsPath;
  const wsId = workspaceId();
  const scope: "project" | "user" = workspaceCwd ? "project" : "user";

  sweepStaleClaudeJsonEntries(logger);
  await sweepBeforeAdd(logger, workspaceCwd);

  const add = await runClaudeCli(
    [
      "mcp",
      "add",
      "-s",
      scope,
      UNIFIED_MCP_NAME,
      "--env",
      `WAT321_WORKSPACE_ID=${wsId}`,
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
  return { ok: true, scriptPath };
}

/** Uninstall the unified bridge. Sweeps both project-scope (the
 * folder-mode registration) and user-scope (the folderless-mode
 * registration plus any defensive sweep target) so a user toggling
 * EH off doesn't leave stale entries behind regardless of whether
 * a folder is open. */
export async function uninstallUnifiedBridge(
  logger: UnifiedLogger = consoleLogger
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
