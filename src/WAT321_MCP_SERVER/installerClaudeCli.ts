import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { writeFileAtomic } from "../engine/fs/atomicWrite";
import { resolveClaudeCli } from "../shared/providers/claude/cliResolver";
import { BIN_DIR, UNIFIED_MCP_NAME } from "./installerScripts";

/**
 * Claude-CLI mechanics used by the bridge installer: `claude mcp ...`
 * subprocess wrapper plus the two pre-add sweeps that defend against
 * artifacts of earlier registration mechanisms. Both sweeps are best-
 * effort: a non-zero exit or unreadable file logs through the supplied
 * logger and returns instead of throwing, so the install / uninstall
 * orchestrator can keep going. The sweeps are required because
 * `claude mcp add` errors on duplicate-name rather than overwriting,
 * so any leftover entry (project or user scope) would block a clean
 * re-register.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface UnifiedLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: UnifiedLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Defensive user-scope sweep before re-registering at project scope.
 * An earlier install path wrote the entry at user scope - if any
 * install still has that, the project-scope add would fail until the
 * user-scope entry is gone. */
const USER_SCOPE_SWEEP_NAMES = [UNIFIED_MCP_NAME] as const;

/** Run `claude mcp ...` with the resolved Claude CLI path. Pass `cwd`
 * for project-scope operations - the CLI reads the working directory
 * to know which workspace's `.claude/settings.json` to mutate. */
export async function runClaudeCli(
  args: string[],
  cwd?: string
): Promise<CliResult> {
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

/** Strip dormant `wat321` MCP entries from `~/.claude.json`'s
 * per-project `mcpServers` map when their args[0] does not match the
 * current bin path. Claude Code reads project-scope MCP from each
 * workspace's `.mcp.json` - the entries under `~/.claude.json`
 * `projects.X.mcpServers.wat321` are dormant artifacts from an
 * earlier registration mechanism that point at a path which no
 * longer exists. Harmless but accumulating - sweep once on every
 * install so the user-wide config stays clean. */
export function sweepStaleClaudeJsonEntries(logger: UnifiedLogger): void {
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
    // dormant entries are inert - next install retries
  }
}

/** Sweep any prior MCP entries (project + user scope) via
 * `claude mcp remove` before re-adding. Best-effort - non-zero exits
 * are normal when the entry was never registered. */
export async function sweepPriorMcpEntries(
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
