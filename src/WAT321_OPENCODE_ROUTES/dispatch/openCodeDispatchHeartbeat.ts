import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../engine/fs/atomicWrite";
import { LAST_USED_PATH, OPENCODE_ROUTES_DIR } from "../openCodeRoutesPaths";

/**
 * OpenCode widget heartbeat + last-used sidecar writers for the FF
 * dispatcher. Cross-tier contract: shares the
 * `<OPENCODE_ROUTES_DIR>/heartbeat.json` + `<LAST_USED_PATH>` shape
 * with the MCP-runtime writer in `WAT321_MCP_SERVER/bin/opencode/heartbeat.mjs`.
 * Atomic tmp+rename so the widget reader never sees a torn write.
 */

const OPENCODE_HEARTBEAT_PATH = join(OPENCODE_ROUTES_DIR, "heartbeat.json");

interface OpenCodeWidgetHeartbeatPayload {
  startedAt: string;
  requestId: string;
  alias: string;
  instanceId: string | null;
  dataRetention: "local" | "retained" | null;
  model: string;
  timeoutMs: number;
}

export function writeOpenCodeWidgetHeartbeat(
  payload: OpenCodeWidgetHeartbeatPayload
): void {
  try {
    if (!existsSync(OPENCODE_ROUTES_DIR)) {
      mkdirSync(OPENCODE_ROUTES_DIR, { recursive: true });
    }
    writeFileAtomic(
      OPENCODE_HEARTBEAT_PATH,
      `${JSON.stringify({
        phase: "calling",
        ...payload,
        tokens: 0,
        tokensPerSec: 0,
        currentPhase: "DISPATCH",
        phaseTrace: [],
      })}\n`
    );
  } catch {
    // best-effort - widget falls back to idle when the file is missing
  }
}

export function clearOpenCodeWidgetHeartbeat(): void {
  try {
    if (existsSync(OPENCODE_HEARTBEAT_PATH)) unlinkSync(OPENCODE_HEARTBEAT_PATH);
  } catch {
    // best-effort
  }
}

interface OpenCodeLastUsedMeta {
  instanceId: string | null;
  alias: string;
  dataRetention: "local" | "retained" | null;
  model: string;
}

/** Persist the last-dispatched instance for the widget's
 * post-heartbeat alias display. Skip when no real instance id resolved
 * so the widget keeps showing the prior good entry. */
export function writeOpenCodeLastUsed(meta: OpenCodeLastUsedMeta): void {
  if (!meta.instanceId) return;
  try {
    if (!existsSync(OPENCODE_ROUTES_DIR)) {
      mkdirSync(OPENCODE_ROUTES_DIR, { recursive: true });
    }
    const payload = {
      instanceId: meta.instanceId,
      alias: meta.alias,
      dataRetention: meta.dataRetention,
      model: meta.model,
      at: new Date().toISOString(),
    };
    writeFileAtomic(LAST_USED_PATH, `${JSON.stringify(payload)}\n`);
  } catch {
    // best-effort
  }
}
