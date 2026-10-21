import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openCodeRoutesStateDir } from "../../engine/wat321Paths";

/**
 * The OpenCode Routes config the Routes tier writes on every settings
 * change (`WAT321_OPENCODE_ROUTES/openCodeRoutesConfig.ts`), read back
 * as the one snapshot every reader shares: the Routes widget and
 * dispatcher, the Epic Handshake session pickers, and the S1
 * auto-create. The MCP runtime reads the same file per call. API key
 * values stay with the writer. Not to be confused with the unified
 * bridge config next to it in `bridgeConfig.ts`.
 */

export const OPENCODE_ROUTES_CONFIG_PATH = join(openCodeRoutesStateDir(), "config.json");

export interface OpenCodeRoutesInstance {
  id: string;
  alias: string;
  kind: "local" | "remote";
  model: string;
  harnessProviderID: "llama.cpp" | "zen";
  dataRetention?: "local" | "retained";
  /** Resolved endpoint URL. Local: the user's `wat321.localEndpoint`
   * (llama-server). Zen: opencode.ai/zen/v1. The session-tokens poller
   * probes `/props` on it for a local model's n_ctx. */
  endpoint?: string;
  apiKeyMissing?: boolean;
  /** Model context window in tokens. A local instance may have it
   * overridden by a runtime `/props.n_ctx` probe. */
  contextWindow?: number;
}

export interface OpenCodeRoutesConfigSnapshot {
  enabled: boolean;
  activeInstanceId: string;
  /** Managed `opencode serve` URL. Empty when OpenCode is disabled or
   * the manager has not spawned the subprocess yet. */
  openCodeServerUrl: string;
  instances: OpenCodeRoutesInstance[];
}

/** Null when the Routes tier has not written the file yet or it is
 * unreadable mid-write. Every field is defaulted: a config left behind
 * by an older install must not throw on the first refresh tick and
 * abort activation. */
export function readOpenCodeRoutesConfigSnapshot(): OpenCodeRoutesConfigSnapshot | null {
  if (!existsSync(OPENCODE_ROUTES_CONFIG_PATH)) return null;
  try {
    const parsed = JSON.parse(
      readFileSync(OPENCODE_ROUTES_CONFIG_PATH, "utf8")
    ) as Partial<OpenCodeRoutesConfigSnapshot>;
    return {
      enabled: parsed.enabled === true,
      activeInstanceId:
        typeof parsed.activeInstanceId === "string" ? parsed.activeInstanceId : "",
      openCodeServerUrl:
        typeof parsed.openCodeServerUrl === "string" ? parsed.openCodeServerUrl : "",
      instances: Array.isArray(parsed.instances) ? parsed.instances : [],
    };
  } catch {
    return null;
  }
}

/** Resolve the catalog instance a dispatch or picker should use. An
 * explicit id wins, then the active instance when it is of `kind`,
 * then `fallbackId` when it is of `kind`, then the first instance of
 * `kind`. Mirrors the MCP runtime's `findInstance` chain in
 * `WAT321_MCP_SERVER/bin/routesConfig.mjs` so both processes resolve
 * identically. */
export function findRoutesInstance(
  cfg: OpenCodeRoutesConfigSnapshot | null,
  instanceId: string | null,
  kind: "remote" | "local" | null,
  fallbackId: string | null = null
): OpenCodeRoutesInstance | null {
  const instances = cfg?.instances ?? [];
  if (instances.length === 0) return null;
  const ofKind = (i: OpenCodeRoutesInstance): boolean =>
    kind === null || i.kind === kind;
  if (instanceId) {
    const found = instances.find((i) => i.id === instanceId);
    if (found) return found;
  }
  if (cfg?.activeInstanceId) {
    const active = instances.find((i) => i.id === cfg.activeInstanceId);
    if (active && ofKind(active)) return active;
  }
  if (fallbackId) {
    const fallback = instances.find((i) => i.id === fallbackId && ofKind(i));
    if (fallback) return fallback;
  }
  return instances.find(ofKind) ?? null;
}
