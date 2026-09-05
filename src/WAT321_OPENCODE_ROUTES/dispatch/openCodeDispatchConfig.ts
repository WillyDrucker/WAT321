import { existsSync, readFileSync } from "node:fs";
import { OPENCODE_ROUTES_CONFIG_PATH } from "../../shared/bridge/openCodeRoutesConfigSnapshot";
import { readAliases, SESSION_ALIASES_PATH } from "../../shared/bridge/sessionAliases";

/**
 * Config + alias readers for the OpenCode / Local LLM dispatcher.
 * Two distinct on-disk surfaces with different per-client subtrees:
 *
 *   - `<openCodeRoutesStateDir()>/config.json` (this file's
 *     OPENCODE_ROUTES_CONFIG_PATH): the live opencode serve URL +
 *     instance catalog `openCodeRoutesConfig.ts` writes. Same file
 *     the MCP-side `routesConfig.mjs` reads, so extension-side
 *     dispatcher and MCP-side sync handler stay in sync.
 *   - `<bridgeStateDir()>/session-aliases.json`: alias map the MCP
 *     runtime's `WAT321_MCP_SERVER/bin/opencode/sessionAliases.mjs` writes. Reading anywhere else
 *     means the dispatcher won't see sessions just created via
 *     `wat321_session`.
 *
 * NOT to be confused: `<bridgeStateDir()>/config.json` is a third
 * file (the unified MCP server's enabled-targets snapshot) that has
 * caused real bugs when read in place of the routes config.
 */

/** Subset of the OpenCode Routes config the extension's `openCodeRoutesConfig.ts`
 * writes. Only the fields this dispatcher reads are typed - the rest
 * of the file (API keys, data retention, etc.) is irrelevant here. */
export interface OpenCodeRoutesConfigSlice {
  /** Live URL of the managed `opencode serve` subprocess. Empty when
   * OpenCode is disabled or the manager hasn't spawned one yet. */
  openCodeServerUrl?: string;
  instances?: Array<{
    id: string;
    alias?: string;
    kind?: "remote" | "local";
    model?: string;
    harnessProviderID?: "llama.cpp" | "zen";
    dataRetention?: "local" | "retained";
  }>;
  activeInstanceId?: string | null;
}

type RoutesInstance = NonNullable<
  OpenCodeRoutesConfigSlice["instances"]
>[number];

export function readRoutesConfig(): OpenCodeRoutesConfigSlice | null {
  try {
    if (!existsSync(OPENCODE_ROUTES_CONFIG_PATH)) return null;
    return JSON.parse(
      readFileSync(OPENCODE_ROUTES_CONFIG_PATH, "utf8")
    ) as OpenCodeRoutesConfigSlice;
  } catch {
    return null;
  }
}

/** Resolve a catalog instance. Explicit id wins - falling back to the
 * kind-filtered active instance - final fallback to any kind-matching
 * entry. Mirrors the MCP-side `routesConfig.mjs:findInstance`
 * fallback chain so dispatchers behave identically across processes. */
export function findInstance(
  cfg: OpenCodeRoutesConfigSlice | null,
  instanceId: string | null,
  kind: "remote" | "local" | null
): RoutesInstance | null {
  const instances = cfg?.instances ?? [];
  if (instances.length === 0) return null;
  if (instanceId) {
    const found = instances.find((i) => i.id === instanceId);
    if (found) return found;
  }
  const activeId = cfg?.activeInstanceId ?? null;
  if (activeId) {
    const active = instances.find((i) => i.id === activeId);
    if (active && (kind === null || active.kind === kind)) return active;
  }
  return instances.find((i) => kind === null || i.kind === kind) ?? null;
}

/** Resolve the session alias the dispatcher should target. Explicit
 * `sessionAlias` on the envelope wins - otherwise read the active
 * alias from disk. Returns null when no session is configured
 * (one-shot path). The envelope's `sessionAlias` is populated from
 * the caller's `session` arg on `wat321_ask` so a caller can target
 * a specific session even when the active is something else. */
export function readActiveAlias(
  target: "opencode" | "local",
  env: { sessionAlias?: string }
): string | null {
  if (typeof env.sessionAlias === "string" && env.sessionAlias.length > 0) {
    return env.sessionAlias;
  }
  const map = readAliases(SESSION_ALIASES_PATH);
  const active = map.activeAliases?.[target];
  if (typeof active === "string" && active.length > 0) return active;
  return null;
}
