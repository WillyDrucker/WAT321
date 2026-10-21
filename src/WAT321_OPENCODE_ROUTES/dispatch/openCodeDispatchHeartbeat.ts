import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { writeFileAtomic } from "../../engine/fs/atomicWrite";
import {
  OPENCODE_HEARTBEAT_PATH,
  type OpenCodeDispatchHeartbeat,
} from "../../shared/bridge/openCodeDispatchHeartbeat";
import { LAST_USED_PATH, OPENCODE_ROUTES_DIR } from "../openCodeRoutesPaths";

/**
 * OpenCode widget heartbeat + last-used sidecar writers for the FF
 * dispatcher. Cross-tier contract: shares the heartbeat shape in
 * `shared/bridge/openCodeDispatchHeartbeat.ts` and the `last-used.json`
 * shape with the MCP-runtime writer in
 * `WAT321_MCP_SERVER/bin/opencode/heartbeat.mjs`. Atomic tmp+rename so
 * the widget reader never sees a torn write.
 */

type WidgetHeartbeatMeta = Pick<
  OpenCodeDispatchHeartbeat,
  "startedAt" | "requestId" | "alias" | "instanceId" | "dataRetention" | "model" | "timeoutMs"
>;

function ensureStateDir(): void {
  if (!existsSync(OPENCODE_ROUTES_DIR)) {
    mkdirSync(OPENCODE_ROUTES_DIR, { recursive: true });
  }
}

/** The FF dispatcher reads the whole reply in one response, so the
 * token fields stay at zero and the widget renders elapsed seconds. */
export function writeOpenCodeWidgetHeartbeat(meta: WidgetHeartbeatMeta): void {
  try {
    ensureStateDir();
    const beat: OpenCodeDispatchHeartbeat = {
      phase: "calling",
      ...meta,
      tokens: 0,
      tokensPerSec: 0,
    };
    writeFileAtomic(OPENCODE_HEARTBEAT_PATH, `${JSON.stringify(beat)}\n`);
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
    ensureStateDir();
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
