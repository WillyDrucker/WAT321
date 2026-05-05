import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

/**
 * Resolve the `claude` and `codex` CLI binaries with a two-tier
 * search: first the user's PATH (the historical assumption), then the
 * binary bundled inside the corresponding VS Code extension if the
 * user has it installed. Lets users who only ever installed the
 * marketplace extensions and never ran a global CLI installer still
 * use Epic Handshake + Model Bridge.
 *
 * The extension bundles a fresher CLI than most users have on PATH
 * because marketplace updates push a new platform-specific binary on
 * every extension release. Preferring PATH preserves existing
 * behavior; the extension-bundled fallback only kicks in when PATH
 * has nothing.
 *
 * Resolved paths are cached for the life of the extension host.
 * Installing or uninstalling Claude Code / Codex extensions
 * mid-session won't be picked up until VS Code reloads, mirroring
 * the existing PATH-only behavior (a fresh CLI install on PATH also
 * needs a reload to take effect).
 */

export interface ResolvedCli {
  /** Argument suitable for `child_process.spawn`. Either a bare
   * command name (PATH resolution at spawn time) or an absolute
   * path to an extension-bundled binary. */
  command: string;
  /** True when the resolved value is a bare command name and must
   * be spawned with `{ shell: true }` on Windows so .cmd shims
   * resolve. False when we have an absolute path and a direct
   * spawn is preferable (no shell quoting concerns). */
  needsShell: boolean;
  /** Diagnostic label surfaced in logs and friendly hints. */
  source: "path" | "extension-bundled";
}

interface CliSpec {
  pathCommand: string;
  extensionId: string;
  bundledRelPath: (platform: NodeJS.Platform) => string | null;
}

const CLAUDE_SPEC: CliSpec = {
  pathCommand: "claude",
  extensionId: "anthropic.claude-code",
  bundledRelPath: (platform) => {
    if (platform === "win32") return join("resources", "native-binary", "claude.exe");
    return join("resources", "native-binary", "claude");
  },
};

const CODEX_SPEC: CliSpec = {
  pathCommand: "codex",
  extensionId: "openai.chatgpt",
  bundledRelPath: (platform) => {
    if (platform === "win32") return join("bin", "windows-x86_64", "codex.exe");
    if (platform === "linux") return join("bin", "linux-x86_64", "codex");
    return null;
  },
};

let claudeCache: ResolvedCli | null | undefined;
let codexCache: ResolvedCli | null | undefined;

/** Spawn `<command> --version` and resolve true on exit code 0.
 * Used both for PATH probing (with shell on win32) and bundled
 * binary probing (no shell needed since we have an absolute path). */
function probeVersion(command: string, useShell: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
      shell: useShell,
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function resolveCli(spec: CliSpec): Promise<ResolvedCli | null> {
  // PATH first. Preserves the historical install path that users with
  // a global CLI install rely on. Win32 needs shell:true so .cmd shims
  // (npm-installed) resolve.
  const pathNeedsShell = process.platform === "win32";
  if (await probeVersion(spec.pathCommand, pathNeedsShell)) {
    return { command: spec.pathCommand, needsShell: pathNeedsShell, source: "path" };
  }

  // Extension-bundled fallback. The user installed the marketplace
  // extension but never installed a global CLI. The extension's
  // install dir resolves via VS Code's stable extensionUri API,
  // so we don't have to glob the version-stamped folder name (which
  // changes on every upgrade).
  const extension = vscode.extensions.getExtension(spec.extensionId);
  if (!extension) return null;
  const relPath = spec.bundledRelPath(process.platform);
  if (relPath === null) return null;
  const absolute = join(extension.extensionUri.fsPath, relPath);
  if (!existsSync(absolute)) return null;
  // Probe to confirm the bundled binary actually runs on this
  // machine before we hand the path to a caller. An extension
  // install for a different architecture (rare but possible with
  // hand-copied extension dirs) would otherwise fail at first use.
  if (!(await probeVersion(absolute, false))) return null;
  return { command: absolute, needsShell: false, source: "extension-bundled" };
}

/** Resolve the Claude Code CLI. Returns null when neither PATH nor the
 * Claude Code VS Code extension bundles a working binary. */
export async function resolveClaudeCli(): Promise<ResolvedCli | null> {
  if (claudeCache !== undefined) return claudeCache;
  claudeCache = await resolveCli(CLAUDE_SPEC);
  return claudeCache;
}

/** Resolve the Codex CLI. Returns null when neither PATH nor the
 * OpenAI Codex VS Code extension bundles a working binary. */
export async function resolveCodexCli(): Promise<ResolvedCli | null> {
  if (codexCache !== undefined) return codexCache;
  codexCache = await resolveCli(CODEX_SPEC);
  return codexCache;
}

/** Drop the cache so the next resolve probes again. Called from the
 * activate-time reset path so a user who just enabled the bridge
 * after installing a CLI doesn't have to reload the window. */
export function resetCliResolverCache(): void {
  claudeCache = undefined;
  codexCache = undefined;
}
