import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeStateDir } from "../shared/wat321Paths";
import { CONFIG_PATH as OPENCODE_ROUTES_CONFIG_PATH } from "./constants";

/**
 * Config + alias readers for the OpenCode / Local LLM dispatcher.
 * Two distinct on-disk surfaces with different per-client subtrees:
 *
 *   - `<openCodeRoutesStateDir()>/config.json` (this file's
 *     OPENCODE_ROUTES_CONFIG_PATH): the live opencode serve URL +
 *     instance catalog the extension's `config.ts` writes. Same file
 *     the MCP-side `opencode/config.mjs` reads, so extension-side
 *     dispatcher and MCP-side sync handler stay in sync.
 *   - `<bridgeStateDir()>/session-aliases.json`: alias map the MCP
 *     runtime's `opencode/aliases.mjs` writes. Reading anywhere else
 *     means the dispatcher won't see sessions just created via
 *     `wat321_session`.
 *
 * NOT to be confused: `<bridgeStateDir()>/config.json` is a third
 * file (the unified MCP server's enabled-targets snapshot) that has
 * caused real bugs when read in place of the routes config.
 */

/** Subset of the OpenCode Routes config the extension's `config.ts`
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

export interface AliasMap {
  opencode?: Record<
    string,
    { sessionId: string; instanceId?: string | null }
  >;
  local?: Record<
    string,
    { sessionId: string; instanceId?: string | null }
  >;
  activeAliases?: { opencode?: string | null; local?: string | null };
}

export type RoutesInstance = NonNullable<
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

function aliasMapPath(): string {
  return join(bridgeStateDir(), "session-aliases.json");
}

export function readAliasMap(): AliasMap {
  const path = aliasMapPath();
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as AliasMap;
  } catch {
    return {};
  }
}

/** Resolve a catalog instance. Explicit id wins - falling back to the
 * kind-filtered active instance - final fallback to any kind-matching
 * entry. Mirrors the MCP-side `opencode/config.mjs:findInstance`
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
  const map = readAliasMap();
  const active = map.activeAliases?.[target];
  if (typeof active === "string" && active.length > 0) return active;
  return null;
}
