import {
  type ResolvedCli,
  registerCacheResetter,
  resolveCli,
} from "../cliResolver";

/**
 * OpenCode CLI resolver. PATH-only - the OpenCode VS Code extension
 * (sst-dev.opencode) is a thin terminal-shortcut wrapper that does
 * not bundle the CLI, so no extension fallback exists.
 */

const SPEC = {
  pathCommand: "opencode",
  extensionId: null,
  bundledRelPath: () => null,
};

let cache: ResolvedCli | null | undefined;
registerCacheResetter(() => {
  cache = undefined;
});

/** Resolve the OpenCode CLI on PATH. Returns null when no `opencode`
 * binary is reachable. */
export async function resolveOpenCodeCli(): Promise<ResolvedCli | null> {
  if (cache !== undefined) return cache;
  cache = await resolveCli(SPEC);
  return cache;
}

/** Sync read of cached resolution. Returns null on failed probe,
 * undefined when no probe has run yet. */
export function peekResolvedOpenCodeCli(): ResolvedCli | null | undefined {
  return cache;
}
