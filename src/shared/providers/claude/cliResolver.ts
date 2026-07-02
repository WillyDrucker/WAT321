import { join } from "node:path";
import {
  type ResolvedCli,
  registerCacheResetter,
  resolveCli,
} from "../cliResolver";

/**
 * Claude Code CLI resolver. Bundled-binary path lives at
 * `resources/native-binary/claude(.exe)` inside the
 * `anthropic.claude-code` VS Code extension - PATH fallback is the
 * bare `claude` command.
 */

const SPEC = {
  pathCommand: "claude",
  extensionId: "anthropic.claude-code",
  bundledRelPath: (platform: NodeJS.Platform) => {
    if (platform === "win32") return join("resources", "native-binary", "claude.exe");
    return join("resources", "native-binary", "claude");
  },
};

let cache: ResolvedCli | null | undefined;
registerCacheResetter(() => {
  cache = undefined;
});

/** Resolve the Claude Code CLI. Returns null when neither PATH nor the
 * Claude Code VS Code extension bundles a working binary. */
export async function resolveClaudeCli(): Promise<ResolvedCli | null> {
  if (cache !== undefined) return cache;
  cache = await resolveCli(SPEC);
  return cache;
}

/** Sync read of cached resolution. Returns null on failed probe,
 * undefined when no probe has run yet. */
export function peekResolvedClaudeCli(): ResolvedCli | null | undefined {
  return cache;
}
