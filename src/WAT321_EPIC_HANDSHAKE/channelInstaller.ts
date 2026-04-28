import { spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type * as vscode from "vscode";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
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

/** Copy a file via temp + rename so an in-flight reader (e.g. Claude
 * Code spawning `node <target>` while we overwrite) cannot observe a
 * torn copy. Same atomic-write contract as `shared/fs/atomicWrite.ts`,
 * scoped to a copy operation. */
function atomicCopy(source: string, target: string): void {
  const tmp = `${target}.tmp`;
  copyFileSync(source, tmp);
  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best-effort
    }
    throw err;
  }
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

/** Path to Claude Code's user-level settings file. We write to
 * `permissions.allow` here so the bridge MCP tools never trip the
 * "Do you want to proceed with mcp__wat321__epic_handshake_ask?"
 * prompt - WAT321 just installed the server, asking the user to
 * re-authorize each tool would be redundant and confusing. */
const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

/** Tool names the bridge needs Claude Code to invoke without prompt.
 * Both names are stable across Codex versions and the MCP SDK
 * (`mcp__<server>__<tool>` form). Adding to `permissions.allow`
 * skips the per-tool prompt for ONLY these two; every other tool
 * still goes through the normal permission gate. */
const BRIDGE_ALLOWED_TOOLS = [
  "mcp__wat321__epic_handshake_ask",
  "mcp__wat321__epic_handshake_inbox",
] as const;

interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Pre-allow the two bridge MCP tools in Claude Code's user-level
 * settings so the user never sees the per-tool permission prompt
 * for tools we just installed. Idempotent - already-present entries
 * are skipped. Best-effort - parse failure (the file may be JSONC
 * with comments that our plain JSON.parse rejects) downgrades to a
 * log line and the user falls back to the standard "allow for this
 * project" dialog click on first dispatch. */
function preAllowBridgeTools(logger: EpicHandshakeLogger): void {
  let settings: ClaudeSettings = {};
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      settings = JSON.parse(
        readFileSync(CLAUDE_SETTINGS_PATH, "utf8")
      ) as ClaudeSettings;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `~/.claude/settings.json parse skipped (${msg}); user will see one-time permission prompt on first bridge call`
      );
      return;
    }
  }

  if (!settings.permissions) settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

  let added = 0;
  for (const tool of BRIDGE_ALLOWED_TOOLS) {
    if (!settings.permissions.allow.includes(tool)) {
      settings.permissions.allow.push(tool);
      added++;
    }
  }
  if (added === 0) return;

  try {
    mkdirSync(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
    const ok = writeFileAtomic(
      CLAUDE_SETTINGS_PATH,
      `${JSON.stringify(settings, null, 2)}\n`
    );
    if (ok) {
      logger.info(
        `pre-allowed ${added} bridge MCP tool(s) in ~/.claude/settings.json`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`~/.claude/settings.json write skipped (${msg})`);
  }
}

/** Reverse of preAllowBridgeTools - remove the two entries we added.
 * Called from uninstallChannel + Reset WAT321 so disabling the bridge
 * leaves the user's allowlist exactly as it was. Best-effort. */
function unAllowBridgeTools(logger: EpicHandshakeLogger): void {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return;
  let settings: ClaudeSettings;
  try {
    settings = JSON.parse(
      readFileSync(CLAUDE_SETTINGS_PATH, "utf8")
    ) as ClaudeSettings;
  } catch {
    return;
  }
  const allow = settings.permissions?.allow;
  if (!Array.isArray(allow)) return;
  const before = allow.length;
  const filtered = allow.filter(
    (t): t is string =>
      typeof t === "string" &&
      !(BRIDGE_ALLOWED_TOOLS as readonly string[]).includes(t)
  );
  if (filtered.length === before) return;
  if (settings.permissions === undefined) return;
  settings.permissions.allow = filtered;
  try {
    writeFileAtomic(
      CLAUDE_SETTINGS_PATH,
      `${JSON.stringify(settings, null, 2)}\n`
    );
    logger.info(
      `removed ${before - filtered.length} bridge MCP tool entry/entries from ~/.claude/settings.json`
    );
  } catch {
    // best-effort
  }
}

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
  preAllowBridgeTools(logger);
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
  unAllowBridgeTools(logger);
}

/** Detect whether `claude` CLI is on PATH and reachable. Returns
 * true if a version check succeeds. */
export async function isClaudeAvailable(): Promise<boolean> {
  const res = await runClaudeCli(["--version"]);
  return res.code === 0;
}

/** Detect whether `codex` CLI is on PATH and reachable. Mirror of
 * `isClaudeAvailable` - the bridge spawns `codex app-server` as a
 * child process, so a missing binary breaks every dispatch. We check
 * before installChannel runs so users without Codex CLI never get
 * MCP registration / permissions.allow entries / channel.mjs extracted.
 * Codex CLI is independent from the Codex VS Code extension; users
 * can have one without the other. The CLI is what matters here. */
export async function isCodexAvailable(): Promise<boolean> {
  const useShell = process.platform === "win32";
  return new Promise((resolve) => {
    const child = spawn("codex", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: useShell,
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}
