import {
  findRoutesInstance,
  type OpenCodeRoutesConfigSnapshot,
  type OpenCodeRoutesInstance,
} from "../../shared/bridge/openCodeRoutesConfigSnapshot";
import type { SessionTarget } from "../../shared/bridge/sessionAliases";

/**
 * Data the OpenCode / Local-LLM "Manage Sessions" submenu reads: the
 * session list from the managed `opencode serve`, the per-target
 * picker configuration, and the catalog instance a target resolves
 * to. Rows are built in `openCodeSessionsRows.ts`, the picker shell
 * lives in `openCodeSessionsPicker.ts`, and the session display name
 * comes from `shared/bridge/bridgeConfig.ts`.
 */

export interface OpenCodeSessionMeta {
  id: string;
  slug?: string;
  title?: string;
  model?: { id?: string; providerID?: string };
  time?: { created?: number; updated?: number };
}

export async function fetchSessions(
  serveUrl: string
): Promise<OpenCodeSessionMeta[]> {
  try {
    const res = await fetch(`${serveUrl}/session`);
    if (!res.ok) return [];
    const data = (await res.json()) as OpenCodeSessionMeta[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

interface TargetConfig {
  title: string;
  instanceKind: "local" | "remote";
  fallbackInstanceId: string;
  emptyHint: string;
}

export const TARGET_CONFIGS: Record<SessionTarget, TargetConfig> = {
  opencode: {
    title: "Manage OpenCode",
    instanceKind: "remote",
    fallbackInstanceId: "big-pickle",
    emptyHint: "No OpenCode sessions yet. The next prompt creates one.",
  },
  local: {
    title: "Manage Local LLM",
    instanceKind: "local",
    fallbackInstanceId: "local-llm",
    emptyHint:
      "No Local LLM sessions yet. The next prompt creates one (requires Local Endpoint set in WAT321 settings).",
  },
};

/** The catalog instance a target dispatches to: the active instance
 * when it matches the target's kind, else the target's fallback, else
 * the first instance of that kind. */
export function pickInstanceForTarget(
  opencodeCfg: OpenCodeRoutesConfigSnapshot | null,
  target: SessionTarget
): OpenCodeRoutesInstance | null {
  const cfg = TARGET_CONFIGS[target];
  return findRoutesInstance(opencodeCfg, null, cfg.instanceKind, cfg.fallbackInstanceId);
}
