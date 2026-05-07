import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type * as vscode from "vscode";
import { atomicCopy } from "../shared/fs/atomicCopy";
import {
  resolveClaudeCli,
  resolveCodexCli,
  resolveOpenCodeCli,
} from "../shared/mcp/cliBinaryResolver";
import { copyProdModules } from "../shared/mcp/copyProdModules";
import { preAllowMcpTools, unAllowMcpTools } from "../shared/mcp/preAllowTools";
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
/** Helper scripts shipped alongside channel.mjs in `bin/`. Extracted
 * to `~/.wat321/epic-handshake/bin/` on install so Claude can invoke
 * them from Bash by absolute path - zero MCP surface token cost, the
 * logic lives on disk instead of baked into a tool description. Keep
 * this list tight; every entry is one more file we install. */
const HELPER_SCRIPT_NAMES = ["stage-clipboard.mjs"] as const;

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
  // Atomic copy: write to <path>.tmp then rename. A direct copyFileSync
  // overwrites in place, which leaves a window where Claude Code
  // spawning `node channel.mjs` mid-overwrite could read torn bytes
  // and parse-fail. Temp+rename closes that window - the rename is
  // atomic on the same filesystem and Claude Code either gets the
  // old script or the fully-written new one, never a partial.
  atomicCopy(source, INSTALLED_SCRIPT_PATH);
  // Also extract helper scripts (e.g. stage-clipboard.mjs) so Claude
  // can invoke them via Bash by absolute path. Skipped silently per
  // script if not present in the vsix - helper scripts are optional
  // extras, their absence never blocks MCP install.
  for (const name of HELPER_SCRIPT_NAMES) {
    const helperCandidates = [
      join(context.extensionPath, "out", "WAT321_EPIC_HANDSHAKE", "bin", name),
      join(context.extensionPath, "src", "WAT321_EPIC_HANDSHAKE", "bin", name),
    ];
    const helperSource = helperCandidates.find((c) => existsSync(c));
    if (helperSource !== undefined) {
      atomicCopy(helperSource, join(BIN_DIR, name));
    }
  }
  return INSTALLED_SCRIPT_PATH;
}

/** Run `claude mcp add <name> -- <command> <args...>`. Returns the
 * process's exit code and captured stderr for diagnostics. Resolves
 * the Claude binary path via `resolveClaudeCli` so users with only
 * the Claude Code VS Code extension (no global CLI install) hit the
 * extension-bundled binary instead of failing on a PATH miss. */
async function runClaudeCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

/** Tool names the bridge needs Claude Code to invoke without prompt.
 * Both names are stable across Codex versions and the MCP SDK
 * (`mcp__<server>__<tool>` form). Adding to `permissions.allow` via
 * `preAllowMcpTools` skips the per-tool prompt for ONLY these two;
 * every other tool still goes through the normal permission gate. */
const BRIDGE_ALLOWED_TOOLS = [
  "mcp__wat321__epic_handshake_ask",
  "mcp__wat321__epic_handshake_inbox",
] as const;

/** Register `wat321` as an MCP server with Claude Code, pointing at
 * the extracted channel.mjs. Idempotent: re-running replaces the
 * existing entry (removes first, then adds). Also pre-allows the
 * two bridge MCP tools in `permissions.allow` so the user is not
 * prompted on first bridge dispatch. */
export async function installChannel(
  context: vscode.ExtensionContext,
  logger: EpicHandshakeLogger
): Promise<InstallResult> {
  let scriptPath: string;
  try {
    scriptPath = extractChannelScript(context);
    logger.info(`channel script extracted to ${scriptPath}`);
    copyProdModules(context, BIN_DIR, logger);
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
  preAllowMcpTools(BRIDGE_ALLOWED_TOOLS, logger);
  return { ok: true, scriptPath };
}

/** Remove the MCP registration AND the `permissions.allow` entries
 * we wrote at install. Disabling the bridge leaves the user's
 * Claude Code settings exactly as we found them. Best-effort. */
export async function uninstallChannel(logger: EpicHandshakeLogger): Promise<void> {
  const res = await runClaudeCli(["mcp", "remove", "-s", "user", MCP_SERVER_NAME]);
  if (res.code === 0) {
    logger.info("claude mcp remove wat321 succeeded");
  } else {
    logger.warn(`claude mcp remove returned code ${res.code}: ${res.stderr.trim()}`);
  }
  unAllowMcpTools(BRIDGE_ALLOWED_TOOLS, logger);
}

/** Detect whether `claude` CLI is reachable via PATH or via the
 * Claude Code VS Code extension's bundled binary. Returns true when
 * either source resolves to a working binary. */
export async function isClaudeAvailable(): Promise<boolean> {
  return (await resolveClaudeCli()) !== null;
}

/** Detect whether `codex` CLI is reachable via PATH or via the OpenAI
 * Codex VS Code extension's bundled binary. We check before
 * installChannel runs so users without either source never get MCP
 * registration / permissions.allow entries / channel.mjs extracted. */
export async function isCodexAvailable(): Promise<boolean> {
  return (await resolveCodexCli()) !== null;
}

/** Detect whether `opencode` CLI is reachable via PATH. The OpenCode
 * VS Code extension does not bundle a CLI, so this is PATH-only. Used
 * by the EH activation gate to satisfy the (Codex OR OpenCode)
 * requirement when Codex isn't installed. */
export async function isOpenCodeAvailable(): Promise<boolean> {
  return (await resolveOpenCodeCli()) !== null;
}
