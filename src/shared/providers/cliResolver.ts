import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
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
  /** Why the other tier lost when it is installed but failed to run,
   * such as a PATH install missing its platform binary. Only a
   * newest-wins spec probes both tiers, so only it fills this. Worth a
   * log line: the binary that runs instead may know fewer models. */
  passedOver?: string;
}

/** A `--version` probe's answer. `failure` is null when the binary was
 * not found at all, an expected state rather than a fault. */
type Probe = { version: string } | { version: null; failure: string | null };

/** One tier's outcome, carrying the failure for the passed-over note. */
interface TierProbe {
  cli: ResolvedCli | null;
  failure: string | null;
}

/** True when the command names a file on PATH, so a failed probe means
 * a broken install rather than none. Searched the way the shell does,
 * PATHEXT included on Windows, because the shell's own not-found
 * message is worded in the system language. */
function isOnPath(command: string): boolean {
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")]
      : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    if (exts.some((ext) => existsSync(join(dir, `${command}${ext}`)))) return true;
  }
  return false;
}

/** The line of a failed probe's stderr that says what went wrong:
 * Node's `Error: ...` line ahead of its stack, else the first line. */
function failureLine(stderr: string, code: number | null): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const text = lines.find((line) => /^\w*Error:\s/.test(line)) ?? lines[0] ?? `exit code ${code}`;
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
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
 * why it did not answer. Used for both PATH probing (with shell on
 * win32) and bundled-binary probing (no shell needed since we have an
 * absolute path). */
function probeVersion(command: string, useShell: boolean): Promise<Probe> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const child = spawn(command, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: useShell,
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (err.length < 8192) err += chunk.toString();
    });
    child.on("error", (e: NodeJS.ErrnoException) =>
      resolve({ version: null, failure: e.code === "ENOENT" ? null : e.message })
    );
    child.on("exit", (code) => {
      if (code === 0) return resolve({ version: out.split("\n")[0]?.trim() ?? "" });
      resolve({ version: null, failure: failureLine(err, code) });
    });
  });
}

/** Probe the spec's extension-bundled binary. No CLI when the extension
 * is absent, opts out, has no binary for this platform, or ships one
 * that cannot execute here (architecture mismatch on a hand-copied
 * extension dir). */
async function probeBundled(spec: CliSpec): Promise<TierProbe> {
  if (spec.extensionId === null) return { cli: null, failure: null };
  const extension = vscode.extensions.getExtension(spec.extensionId);
  if (!extension) return { cli: null, failure: null };
  const relPath = spec.bundledRelPath(process.platform);
  if (relPath === null) return { cli: null, failure: null };
  const absolute = join(extension.extensionUri.fsPath, relPath);
  if (!existsSync(absolute)) return { cli: null, failure: null };
  const probe = await probeVersion(absolute, false);
  if (probe.version === null) return { cli: null, failure: probe.failure };
  return {
    cli: { command: absolute, needsShell: false, source: "extension-bundled", version: probe.version },
    failure: null,
  };
}

/** Probe the spec's PATH command. Win32 needs shell:true so .cmd shims
 * resolve. */
async function probePath(spec: CliSpec): Promise<TierProbe> {
  const needsShell = process.platform === "win32";
  const probe = await probeVersion(spec.pathCommand, needsShell);
  if (probe.version === null) {
    // Through a shell a missing command fails like a broken one, so only
    // a command found on PATH counts as broken.
    return { cli: null, failure: isOnPath(spec.pathCommand) ? probe.failure : null };
  }
  return {
    cli: { command: spec.pathCommand, needsShell, source: "path", version: probe.version },
    failure: null,
  };
}

/** The winner, noting the other tier when it is installed but broken. */
function withPassedOver(
  cli: ResolvedCli | null,
  loser: TierProbe,
  loserLabel: string
): ResolvedCli | null {
  if (cli === null || loser.failure === null) return cli;
  return { ...cli, passedOver: `${loserLabel} failed to run (${loser.failure})` };
}

export async function resolveCli(spec: CliSpec): Promise<ResolvedCli | null> {
  if (spec.compareVersions === undefined) {
    // Legacy order: extension-bundled short-circuits PATH.
    return (await probeBundled(spec)).cli ?? (await probePath(spec)).cli;
  }

  // Newest wins. Probing both costs one extra `--version` spawn on the
  // first resolve of a window, and the result is cached thereafter.
  const [bundled, onPath] = await Promise.all([
    probeBundled(spec),
    probePath(spec),
  ]);
  if (bundled.cli === null) {
    return withPassedOver(onPath.cli, bundled, `the ${spec.extensionId} extension's ${spec.pathCommand}`);
  }
  if (onPath.cli === null) {
    return withPassedOver(bundled.cli, onPath, `${spec.pathCommand} on PATH`);
  }
  // Ties go to the bundled binary: it is the one the user's extension
  // was built and tested against.
  return spec.compareVersions(onPath.cli.version, bundled.cli.version) > 0
    ? onPath.cli
    : bundled.cli;
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
