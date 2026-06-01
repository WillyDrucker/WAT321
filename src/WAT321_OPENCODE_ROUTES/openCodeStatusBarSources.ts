import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeStateDir } from "../shared/wat321Paths";
import {
  CONFIG_PATH,
  LAST_USED_PATH,
  OPENCODE_ROUTES_DIR,
  USAGE_PATH,
} from "./constants";

/**
 * Data sources for the OpenCode Routes status-bar item: the four
 * synchronous JSON readers (heartbeat, config, usage, last-used),
 * the bridge alias lookup, the type contracts they parse into, and
 * the helpers that resolve "which instance is the widget displaying
 * right now" + "what bridge target does it map to". Pulled out so
 * the widget factory file owns only orchestration and the refresh
 * file owns only render.
 *
 * All readers are best-effort: missing files / parse errors fall
 * through to null so the 1Hz refresh loop never throws from a
 * malformed sidecar.
 */

export interface PhaseEntry {
  phase: string;
  elapsedMs: number;
  summary?: string;
}

export interface Heartbeat {
  phase: "calling";
  requestId?: string;
  startedAt: string;
  alias: string;
  instanceId?: string;
  dataRetention?: "local" | "retained";
  model: string;
  timeoutMs: number;
  tokens?: number;
  tokensPerSec?: number;
  currentPhase?: string;
  phaseTrace?: PhaseEntry[];
}

export interface ConfigSnapshot {
  enabled: boolean;
  activeInstanceId: string;
  /** Managed OpenCode subprocess URL. Empty when the bridge is
   * disabled or the manager has not spawned the subprocess yet. */
  openCodeServerUrl?: string;
  instances: Array<{
    id: string;
    alias: string;
    kind: "local" | "remote";
    dataRetention: "local" | "retained";
    /** Resolved endpoint URL. Local: the user's `wat321.localEndpoint`
     * (llama-server). Zen: opencode.ai/zen/v1. Used by the session-
     * tokens poller to probe `/props` for local n_ctx. */
    endpoint?: string;
    apiKeyMissing?: boolean;
    model?: string;
    /** Model context window in tokens. Local instances may have this
     * overridden by a runtime `/props.n_ctx` probe. */
    contextWindow?: number;
  }>;
}

export interface UsageSnapshot {
  sinceMs: number;
  instances: Record<
    string,
    { input: number; output: number; calls: number; lastTs?: string }
  >;
}

const BRIDGE_ALIAS_PATH = join(bridgeStateDir(), "session-aliases.json");

/** Active S<n> alias for the given bridge target. The map persists
 * `S1` / `S2` / etc. keyed by target ("opencode" / "local") and
 * tracks which one is currently active. The Routes widget surfaces
 * this S# so its tooltip reads parallel to Claude / Codex session
 * tokens. */
export function readActiveBridgeAlias(
  target: "opencode" | "local"
): string | null {
  if (!existsSync(BRIDGE_ALIAS_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(BRIDGE_ALIAS_PATH, "utf8")) as {
      activeAliases?: { opencode?: string | null; local?: string | null };
    };
    const active = parsed.activeAliases?.[target];
    return typeof active === "string" && active.length > 0 ? active : null;
  } catch {
    return null;
  }
}

/** Heartbeat path. Per-client state dir already partitions per
 * workspace via wsId so no further suffix is required. */
export function heartbeatPath(): string {
  return join(OPENCODE_ROUTES_DIR, "heartbeat.json");
}

export function readHeartbeat(): Heartbeat | null {
  const path = heartbeatPath();
  if (!path || !existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length === 0) return null;
    const parsed = JSON.parse(raw) as Heartbeat;
    if (typeof parsed?.startedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readConfigSnapshot(): ConfigSnapshot | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<ConfigSnapshot>;
    // Defensive defaults for legacy flat-config.json files. Without
    // these, reading a stale config from a prior install throws on
    // the first refresh tick and aborts activation.
    return {
      enabled: parsed.enabled === true,
      activeInstanceId:
        typeof parsed.activeInstanceId === "string"
          ? parsed.activeInstanceId
          : "",
      openCodeServerUrl:
        typeof parsed.openCodeServerUrl === "string"
          ? parsed.openCodeServerUrl
          : "",
      instances: Array.isArray(parsed.instances) ? parsed.instances : [],
    };
  } catch {
    return null;
  }
}

export function readUsageSnapshot(): UsageSnapshot | null {
  if (!existsSync(USAGE_PATH)) return null;
  try {
    const raw = readFileSync(USAGE_PATH, "utf8");
    return JSON.parse(raw) as UsageSnapshot;
  } catch {
    return null;
  }
}

/** Last instance id with a successful dispatch this session. Null
 * otherwise. Drives display priority (the widget shows the most
 * recently used route, not necessarily the configured default). */
export function readLastUsedInstanceId(): string | null {
  try {
    if (!existsSync(LAST_USED_PATH)) return null;
    const raw = readFileSync(LAST_USED_PATH, "utf8");
    const parsed = JSON.parse(raw) as { instanceId?: unknown };
    return typeof parsed.instanceId === "string" && parsed.instanceId.length > 0
      ? parsed.instanceId
      : null;
  } catch {
    return null;
  }
}

/** Pick the instance the widget should currently render. Last-used
 * wins over the configured `activeInstanceId` for DISPLAY so the
 * widget reflects the most recent dispatch (e.g. user just ran Big
 * Pickle - widget shows Big Pickle even if their default routing is
 * local-llm). Routing decisions still consult `activeInstanceId`;
 * this only affects what label/stats render. */
export function activeInstanceFrom(
  snap: ConfigSnapshot
): ConfigSnapshot["instances"][number] | null {
  const lastUsedId = readLastUsedInstanceId();
  if (lastUsedId) {
    const lastUsed = snap.instances.find((i) => i.id === lastUsedId);
    if (lastUsed) return lastUsed;
  }
  const found = snap.instances.find((i) => i.id === snap.activeInstanceId);
  if (found) return found;
  return snap.instances[0] ?? null;
}

/** Bridge target ("opencode" or "local") for the displayed instance
 * so the active S# can be looked up in the alias map. Local LLM
 * maps to "local"; every Zen route (Big Pickle and friends) maps to
 * "opencode". Null when no instance is selected. */
export function targetForInstance(
  instance: ConfigSnapshot["instances"][number] | null
): "opencode" | "local" | null {
  if (!instance) return null;
  return instance.kind === "local" ? "local" : "opencode";
}

/** Token formatter for the OpenCode Routes widget. Differs from
 * `shared/ui/tokenFormatters.formatTokens` in two ways:
 *   - sub-1k values render with locale thousand separators (e.g.
 *     "1,234") instead of bare integers
 *   - sub-10k values render with one decimal (`1.5k`) instead of
 *     rounded thousands (`2k`)
 * The Routes widget shows smaller token counts than the Claude /
 * Codex session-token widgets so the extra precision matters more
 * here. */
export function formatRouteTokens(n: number): string {
  if (n < 1000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
