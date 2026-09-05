import { readBridgeProjectName } from "../../shared/bridge/bridgeConfig";
import type {
  OpenCodeRoutesConfigSnapshot,
  OpenCodeRoutesInstance,
} from "../../shared/bridge/openCodeRoutesConfigSnapshot";
import type { SessionTarget } from "../../shared/bridge/sessionAliases";

/**
 * Data the OpenCode / Local-LLM "Manage Sessions" submenu reads: the
 * session list from the managed `opencode serve`, the per-target
 * picker configuration, the catalog instance a target resolves to,
 * and the session display name every surface shares. Rows are built
 * in `openCodeSessionsRows.ts` and the picker shell lives in
 * `openCodeSessionsPicker.ts`.
 */

/** Standardized session display label. Mirrors the unified bridge
 * handlers so the picker, bridge response text, and any future
 * surfaces all read the same way. */
export function formatSessionDisplayName(
  target: SessionTarget,
  alias: string
): string {
  const targetLabel = target === "local" ? "Local" : "OpenCode";
  return `${readBridgeProjectName()} Epic Handshake Claude-to-${targetLabel} ${alias}`;
}

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
  if (!opencodeCfg) return null;
  const cfg = TARGET_CONFIGS[target];
  const instances = opencodeCfg.instances ?? [];
  const candidates = instances.filter((i) => i.kind === cfg.instanceKind);
  if (candidates.length === 0) return null;
  const active = candidates.find((i) => i.id === opencodeCfg.activeInstanceId);
  if (active) return active;
  const fallback = candidates.find(
    (i) => i.id === cfg.fallbackInstanceId
  );
  if (fallback) return fallback;
  return candidates[0];
}
