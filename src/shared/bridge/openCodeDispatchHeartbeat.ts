import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openCodeRoutesStateDir } from "../../engine/wat321Paths";

/**
 * The OpenCode Routes dispatch heartbeat, `heartbeat.json` in the
 * Routes state dir. Written for the duration of every OpenCode or
 * Local LLM call with a 5s keepalive by the Routes dispatcher
 * (`WAT321_OPENCODE_ROUTES/dispatch/openCodeDispatchHeartbeat.ts`) and
 * the MCP runtime (`WAT321_MCP_SERVER/bin/opencode/heartbeat.mjs`), and
 * unlinked on completion. The Routes widget renders it as the live
 * "calling" badge, the Epic Handshake widget synthesizes a stage walk
 * from it, and the session-token widgets gate their animations on it.
 * The per-client state dir already partitions per workspace, so the
 * file needs no hash suffix.
 */

export const OPENCODE_HEARTBEAT_PATH = join(openCodeRoutesStateDir(), "heartbeat.json");

/** One missed keepalive plus filesystem latency. A heartbeat older
 * than this belongs to a dispatch that died without unlinking it. */
const OPENCODE_HEARTBEAT_STALE_MS = 15_000;

export interface OpenCodeDispatchHeartbeat {
  phase: "calling";
  requestId?: string;
  startedAt: string;
  alias: string;
  instanceId?: string | null;
  dataRetention?: "local" | "retained" | null;
  model: string;
  timeoutMs: number;
  tokens?: number;
  tokensPerSec?: number;
}

/** The live heartbeat, or null when the file is absent, empty, or
 * torn. */
export function readOpenCodeDispatchHeartbeat(): OpenCodeDispatchHeartbeat | null {
  try {
    if (!existsSync(OPENCODE_HEARTBEAT_PATH)) return null;
    const raw = readFileSync(OPENCODE_HEARTBEAT_PATH, "utf8").trim();
    if (raw.length === 0) return null;
    const parsed = JSON.parse(raw) as OpenCodeDispatchHeartbeat;
    return typeof parsed?.startedAt === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Wall-clock start of the in-flight dispatch, or null when none. */
export function openCodeDispatchStartedAtMs(): number | null {
  const hb = readOpenCodeDispatchHeartbeat();
  if (hb === null) return null;
  const t = new Date(hb.startedAt).getTime();
  return Number.isFinite(t) ? t : null;
}

/** True while the heartbeat has been refreshed within the stale
 * window. The Claude session-token widget renders a waiting-on-
 * OpenCode blink on it, and the Codex widget suppresses its bridge
 * ceremony when the active dispatch targets another backend. */
export function isOpenCodeDispatchActive(): boolean {
  try {
    if (!existsSync(OPENCODE_HEARTBEAT_PATH)) return false;
    return Date.now() - statSync(OPENCODE_HEARTBEAT_PATH).mtimeMs < OPENCODE_HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}
