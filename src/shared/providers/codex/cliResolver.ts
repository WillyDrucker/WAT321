import { join } from "node:path";
import {
  type ResolvedCli,
  registerCacheResetter,
  resolveCli,
} from "../cliResolver";

/**
 * Codex CLI resolver. Bundled binary lives under
 * `bin/<arch>/codex(.exe)` inside the `openai.chatgpt` VS Code
 * extension - PATH fallback is the bare `codex` command.
 */

const SPEC = {
  pathCommand: "codex",
  extensionId: "openai.chatgpt",
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
