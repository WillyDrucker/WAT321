import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type * as vscode from "vscode";
import { BIN_DIR, EPIC_HANDSHAKE_DIR } from "./constants";
import type { EpicHandshakeLogger } from "./types";

/**
 * Install / uninstall WAT321's MCP server as a registered Claude Code
 * MCP entry. We never edit ~/.claude.json directly - instead we invoke
 * `claude mcp add/remove` which goes through Claude's own CLI. Claude
 * writes its own state through its own code path with its own trust
 * dialog.
 *
 * The channel.mjs script is bundled in the .vsix and extracted to
 * ~/.wat321/epic-handshake/bin/channel.mjs on first install.
 */

const MCP_SERVER_NAME = "wat321";
const CHANNEL_SCRIPT_NAME = "channel.mjs";
const INSTALLED_SCRIPT_PATH = join(BIN_DIR, CHANNEL_SCRIPT_NAME);

export interface InstallResult {
  ok: boolean;
  scriptPath: string;
  error?: string;
}

/** Extract channel.mjs from the extension's bundled assets into
 * `~/.wat321/epic-handshake/bin/`. Overwrites on every install so
 * updates land automatically. */
export function extractChannelScript(context: vscode.ExtensionContext): string {
  if (!existsSync(EPIC_HANDSHAKE_DIR)) {
    mkdirSync(EPIC_HANDSHAKE_DIR, { recursive: true });
  }
  if (!existsSync(BIN_DIR)) {
    mkdirSync(BIN_DIR, { recursive: true });
  }
  // The script lives in src/WAT321_EPIC_HANDSHAKE/bin/ and gets
  // packaged to out/WAT321_EPIC_HANDSHAKE/bin/ via the tsconfig copy
  // step. In dev (F5) it may also be at src/... via the extension
  // context path. Try both.
  const candidates = [
    join(context.extensionPath, "out", "WAT321_EPIC_HANDSHAKE", "bin", CHANNEL_SCRIPT_NAME),
    join(context.extensionPath, "src", "WAT321_EPIC_HANDSHAKE", "bin", CHANNEL_SCRIPT_NAME),
  ];
  let source: string | null = null;
  for (const c of candidates) {
    if (existsSync(c)) {
      source = c;
      break;
    }
  }
  if (source === null) {
    throw new Error(
      `channel.mjs not found in extension package (tried ${candidates.join(", ")})`
    );
  }
  const dir = dirname(INSTALLED_SCRIPT_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  copyFileSync(source, INSTALLED_SCRIPT_PATH);
  return INSTALLED_SCRIPT_PATH;
}

/** Run `claude mcp add <name> -- <command> <args...>`. Returns the
 * process's exit code and captured stderr for diagnostics. */
function runClaudeCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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
    child.stdout?.on("data", (c: string) => { stdout += c; });
    child.stderr?.on("data", (c: string) => { stderr += c; });
    child.on("error", (err) => {
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on("exit", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Copy only the runtime (non-dev) packages from the extension's
 * `node_modules` into `~/.wat321/epic-handshake/bin/node_modules/`
 * so the channel.mjs subprocess can resolve its deps without
 * dragging in the dev-only footprint (eslint / typescript / etc.).
 *
 * Reads the bundled `out/WAT321_EPIC_HANDSHAKE/prod-modules.json`
 * manifest emitted at build time from `package-lock.json`. This
 * keeps the runtime free of any dependency on a shipped lockfile
 * and avoids bundling the full lockfile metadata into the VSIX. */
function copyMcpSdk(context: vscode.ExtensionContext, logger: EpicHandshakeLogger): void {
  const manifestPath = join(
    context.extensionPath,
    "out",
    "WAT321_EPIC_HANDSHAKE",
    "prod-modules.json"
  );
  if (!existsSync(manifestPath)) {
    logger.warn(`prod-modules.json not found at ${manifestPath}; channel may fail to import`);
    return;
  }
  let prodKeys: string[];
  try {
    prodKeys = JSON.parse(readFileSync(manifestPath, "utf8")) as string[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`prod-modules.json parse failed: ${msg}`);
    return;
  }

  let copied = 0;
  for (const key of prodKeys) {
    const srcPath = join(context.extensionPath, key);
    const dstPath = join(BIN_DIR, key);
    if (!existsSync(srcPath)) continue;
    try {
      mkdirSync(dirname(dstPath), { recursive: true });
      cpSync(srcPath, dstPath, { recursive: true, force: true });
      copied++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`copy failed for ${key}: ${msg}`);
    }
  }
  logger.info(`node_modules copy complete: ${copied} prod packages copied`);
}

/** Register `wat321` as an MCP server with Claude Code, pointing at
 * the extracted channel.mjs. Idempotent: re-running replaces the
 * existing entry (removes first, then adds). */
export async function installChannel(
  context: vscode.ExtensionContext,
  logger: EpicHandshakeLogger
): Promise<InstallResult> {
  let scriptPath: string;
  try {
    scriptPath = extractChannelScript(context);
    logger.info(`channel script extracted to ${scriptPath}`);
    copyMcpSdk(context, logger);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, scriptPath: INSTALLED_SCRIPT_PATH, error: msg };
  }

  // Remove prior registration at user scope (ignore errors - might not exist)
  await runClaudeCli(["mcp", "remove", "-s", "user", MCP_SERVER_NAME]);

  // Add fresh registration at user scope so it's visible from any
  // workspace. Default scope is "local" which only applies to the
  // current workspace and can hide the entry from `claude mcp list`
  // when invoked from elsewhere.
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
  logger.info("claude mcp add wat321 succeeded");
  return { ok: true, scriptPath };
}

/** Remove the MCP registration. Best-effort. */
export async function uninstallChannel(logger: EpicHandshakeLogger): Promise<void> {
  const res = await runClaudeCli(["mcp", "remove", "-s", "user", MCP_SERVER_NAME]);
  if (res.code === 0) {
    logger.info("claude mcp remove wat321 succeeded");
  } else {
    logger.warn(`claude mcp remove returned code ${res.code}: ${res.stderr.trim()}`);
  }
}

/** Detect whether `claude` CLI is on PATH and reachable. Returns
 * true if a version check succeeds. */
export async function isClaudeAvailable(): Promise<boolean> {
  const res = await runClaudeCli(["--version"]);
  return res.code === 0;
}
