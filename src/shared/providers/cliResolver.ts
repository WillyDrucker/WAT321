import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

/**
 * Provider-agnostic CLI resolver. Probes `<command> --version` across a
 * two-tier search: VS Code extension-bundled binary, and PATH.
 *
 * Which tier wins depends on the spec. By default extension-bundled
 * wins, on the assumption that a marketplace extension is fresher than
 * whatever sits on PATH. A spec may instead supply `compareVersions`,
 * in which case BOTH tiers are probed and the newer binary wins. Codex
 * opts in because that assumption is demonstrably false there: a stale
 * ChatGPT extension can bundle a Codex several minor versions behind
 * the user's npm CLI, and the older binary knows fewer models.
 *
 * Per-provider specs live in `<provider>/cliResolver.ts` and call into
 * `resolveCli()` with their pathCommand + extensionId + bundled-binary
 * resolver. The shared cache (`resetCliResolverCache()`) is invalidated
 * at activate so a freshly-installed CLI is picked up without a window
 * reload.
 */

export interface ResolvedCli {
  /** Argument suitable for `child_process.spawn`. Either a bare command
   * name (PATH resolution at spawn time) or an absolute path to an
   * extension-bundled binary. */
  command: string;
  /** True when the resolved value is a bare command name and must be
   * spawned with `{ shell: true }` on Windows so .cmd shims resolve.
   * False when we have an absolute path - direct spawn is preferable
   * (no shell quoting concerns). */
  needsShell: boolean;
  /** Diagnostic label surfaced in logs and friendly hints. */
  source: "path" | "extension-bundled";
  /** Raw first line of `<command> --version`, e.g. `codex-cli 0.144.1`.
   * Empty when the binary answered on exit 0 but printed nothing.
   * Callers key caches on this so a binary upgraded in place invalidates
   * anything derived from the older one. */
  version: string;
}

interface CliSpec {
  pathCommand: string;
  /** Extension id whose bundled binary serves as the fallback when
   * PATH probing fails. `null` opts out of extension probing entirely
   * for tools whose extension is a thin shortcut wrapper that does not
   * bundle the CLI (e.g. OpenCode). */
  extensionId: string | null;
  bundledRelPath: (platform: NodeJS.Platform) => string | null;
  /** Opt in to newest-wins selection. Returns >0 when `a` is newer than
   * `b`. When present, both tiers are probed and the newer one is
   * returned. When absent, extension-bundled short-circuits PATH. */
  compareVersions?: (a: string, b: string) => number;
}

/** Spawn `<command> --version` and resolve its first stdout line, or
 * null when the binary is missing or exits non-zero. Used for both PATH
 * probing (with shell on win32) and bundled-binary probing (no shell
 * needed since we have an absolute path). */
function probeVersion(
  command: string,
  useShell: boolean
): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(command, ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      shell: useShell,
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => {
      if (code !== 0) return resolve(null);
      resolve(out.split("\n")[0]?.trim() ?? "");
    });
  });
}

/** Probe the spec's extension-bundled binary, or null when the
 * extension is absent, opts out, has no binary for this platform, or
 * ships one that cannot execute here (architecture mismatch on a
 * hand-copied extension dir). */
async function probeBundled(spec: CliSpec): Promise<ResolvedCli | null> {
  if (spec.extensionId === null) return null;
  const extension = vscode.extensions.getExtension(spec.extensionId);
  if (!extension) return null;
  const relPath = spec.bundledRelPath(process.platform);
  if (relPath === null) return null;
  const absolute = join(extension.extensionUri.fsPath, relPath);
  if (!existsSync(absolute)) return null;
  const version = await probeVersion(absolute, false);
  if (version === null) return null;
  return {
    command: absolute,
    needsShell: false,
    source: "extension-bundled",
    version,
  };
}

/** Probe the spec's PATH command. Win32 needs shell:true so .cmd shims
 * resolve. */
async function probePath(spec: CliSpec): Promise<ResolvedCli | null> {
  const needsShell = process.platform === "win32";
  const version = await probeVersion(spec.pathCommand, needsShell);
  if (version === null) return null;
  return {
    command: spec.pathCommand,
    needsShell,
    source: "path",
    version,
  };
}

export async function resolveCli(spec: CliSpec): Promise<ResolvedCli | null> {
  if (spec.compareVersions === undefined) {
    // Legacy order: extension-bundled short-circuits PATH.
    return (await probeBundled(spec)) ?? (await probePath(spec));
  }

  // Newest wins. Probing both costs one extra `--version` spawn on the
  // first resolve of a window, and the result is cached thereafter.
  const [bundled, onPath] = await Promise.all([
    probeBundled(spec),
    probePath(spec),
  ]);
  if (bundled === null) return onPath;
  if (onPath === null) return bundled;
  // Ties go to the bundled binary: it is the one the user's extension
  // was built and tested against.
  return spec.compareVersions(onPath.version, bundled.version) > 0
    ? onPath
    : bundled;
}

const cacheResetters: Array<() => void> = [];

/** Each provider's resolver registers a cache-clear callback so the
 * shared `resetCliResolverCache()` flushes everyone in one call. */
export function registerCacheResetter(fn: () => void): void {
  cacheResetters.push(fn);
}

/** Drop every provider's cache so the next resolve probes again.
 * Called from the activate-time reset path so a user who just enabled
 * the bridge after installing a CLI doesn't have to reload the window. */
export function resetCliResolverCache(): void {
  for (const reset of cacheResetters) reset();
}
