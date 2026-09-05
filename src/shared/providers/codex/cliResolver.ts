import { join } from "node:path";
import {
  type ResolvedCli,
  registerCacheResetter,
  resolveCli,
} from "../cliResolver";

/**
 * Codex CLI resolver. Bundled binary lives under
 * `bin/<arch>/codex(.exe)` inside the `openai.chatgpt` VS Code
 * extension, and PATH holds the bare `codex` command.
 *
 * Unlike the other providers, Codex resolves NEWEST WINS rather than
 * bundled-first. Which Codex we spawn decides which models exist: an
 * older binary reports fewer models from `model/list` and rejects the
 * newer ones outright. A ChatGPT extension left behind by an earlier
 * install can bundle a Codex several minor versions behind the user's
 * npm CLI (observed: bundled 0.140.0-alpha.2 against a PATH 0.144.1,
 * where only the latter knows the GPT-5.6 family), so preferring the
 * bundled binary silently costs the user models they can run.
 */

interface CodexVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers, e.g. `alpha.4`. Null on a
   * release build, which always sorts above any prerelease. */
  prerelease: string[] | null;
}

/** Pull `0.144.0-alpha.4` out of `codex-cli 0.144.0-alpha.4`. Null when
 * the line carries no recognizable version, which sorts below anything
 * that does. */
function parseCodexVersion(raw: string): CodexVersion | null {
  const m = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(raw);
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? null : m[4].split("."),
  };
}

/** Semver-shaped comparison, enough for Codex's own numbering. Returns
 * >0 when `a` is newer. A release outranks any prerelease of the same
 * version, and prerelease identifiers compare numerically when both are
 * numeric so `alpha.10` correctly outranks `alpha.2`. */
function compareCodexVersions(a: string, b: string): number {
  const va = parseCodexVersion(a);
  const vb = parseCodexVersion(b);
  if (va === null && vb === null) return 0;
  if (va === null) return -1;
  if (vb === null) return 1;

  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  if (va.patch !== vb.patch) return va.patch - vb.patch;

  if (va.prerelease === null && vb.prerelease === null) return 0;
  if (va.prerelease === null) return 1;
  if (vb.prerelease === null) return -1;

  const len = Math.max(va.prerelease.length, vb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const pa = va.prerelease[i];
    const pb = vb.prerelease[i];
    // A shorter identifier list sorts lower, per semver.
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    const na = Number(pa);
    const nb = Number(pb);
    const bothNumeric = !Number.isNaN(na) && !Number.isNaN(nb);
    if (bothNumeric) {
      if (na !== nb) return na - nb;
    } else if (pa !== pb) {
      return pa < pb ? -1 : 1;
    }
  }
  return 0;
}

const SPEC = {
  pathCommand: "codex",
  extensionId: "openai.chatgpt",
  compareVersions: compareCodexVersions,
  bundledRelPath: (platform: NodeJS.Platform) => {
    if (platform === "win32") return join("bin", "windows-x86_64", "codex.exe");
    if (platform === "linux") return join("bin", "linux-x86_64", "codex");
    if (platform === "darwin") {
      // Apple Silicon vs Intel routing. existsSync downstream handles
      // "extension installed but folder missing" gracefully so a
      // single-arch extension doesn't break the resolver.
      const arch = process.arch === "arm64" ? "darwin-arm64" : "darwin-x86_64";
      return join("bin", arch, "codex");
    }
    return null;
  },
};

let cache: ResolvedCli | null | undefined;
registerCacheResetter(() => {
  cache = undefined;
});

/** Resolve the Codex CLI. Returns null when neither PATH nor the
 * OpenAI Codex VS Code extension bundles a working binary. */
export async function resolveCodexCli(): Promise<ResolvedCli | null> {
  if (cache !== undefined) return cache;
  cache = await resolveCli(SPEC);
  return cache;
}

/** Sync read of cached resolution. Returns null on failed probe,
 * undefined when no probe has run yet. */
export function peekResolvedCodexCli(): ResolvedCli | null | undefined {
  return cache;
}
