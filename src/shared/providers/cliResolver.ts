import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

/**
 * Provider-agnostic CLI resolver. Probes for `<command> --version` in
 * a two-tier search: VS Code extension-bundled binary first, then PATH.
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
}

export interface CliSpec {
  pathCommand: string;
  /** Extension id whose bundled binary serves as the fallback when
   * PATH probing fails. `null` opts out of extension probing entirely
   * for tools whose extension is a thin shortcut wrapper that does not
   * bundle the CLI (e.g. OpenCode). */
  extensionId: string | null;
  bundledRelPath: (platform: NodeJS.Platform) => string | null;
}

/** Spawn `<command> --version` and resolve true on exit code 0. Used
 * for both PATH probing (with shell on win32) and bundled-binary
 * probing (no shell needed since we have an absolute path). */
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

export async function resolveCli(spec: CliSpec): Promise<ResolvedCli | null> {
  // Extension-bundled first. Marketplace extensions are typically
  // fresher than whatever the user has on PATH (npm-global stale,
  // hand-copied, etc.). Specs with extensionId === null opt out -
  // their extension doesn't bundle a CLI.
  if (spec.extensionId !== null) {
    const extension = vscode.extensions.getExtension(spec.extensionId);
    if (extension) {
      const relPath = spec.bundledRelPath(process.platform);
      if (relPath !== null) {
        const absolute = join(extension.extensionUri.fsPath, relPath);
        // Probe the bundled binary before handing the path to a
        // caller. Architecture mismatches on hand-copied extension
        // dirs would otherwise fail at first use.
        if (existsSync(absolute) && (await probeVersion(absolute, false))) {
          return {
            command: absolute,
            needsShell: false,
            source: "extension-bundled",
          };
        }
      }
    }
  }

  // PATH fallback. Win32 needs shell:true so .cmd shims resolve.
  const pathNeedsShell = process.platform === "win32";
  if (await probeVersion(spec.pathCommand, pathNeedsShell)) {
    return {
      command: spec.pathCommand,
      needsShell: pathNeedsShell,
      source: "path",
    };
  }

  return null;
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
