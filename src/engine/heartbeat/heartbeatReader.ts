import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EH_ROOT_DIR } from "../inbox/inboxPaths";
import {
  type Heartbeat,
  type HeartbeatStage,
} from "./heartbeatTypes";

/**
 * Reader for the per-turn heartbeat sidecar files every dispatcher
 * writes during a long-running dispatch. Consumed by:
 *   - `bridgeStageCoordinator` for the 5-stage glyph animation.
 *   - The Claude session-tokens widget animation gate.
 *   - The MCP server's adaptive wait loop (separately, via its own
 *     mjs path - see `WAT321_MCP_SERVER/bin/codex.mjs`).
 *
 * Heartbeat staleness: files older than HEARTBEAT_STALENESS_MS without
 * a fresh write are treated as dead turns and skipped. The dispatcher
 * refreshes on every progress signal so anything older indicates a
 * crashed-mid-turn or shutdown-mid-turn leftover.
 */

const HEARTBEAT_STALENESS_MS = 120_000;

const VALID_STAGES: ReadonlySet<HeartbeatStage> = new Set<HeartbeatStage>([
  "dispatched",
  "received",
  "working",
  "writing",
  "complete",
]);

function isStage(value: unknown): value is HeartbeatStage {
  return typeof value === "string" && VALID_STAGES.has(value as HeartbeatStage);
}

/** Read the newest fresh heartbeat for the given workspace hash, or
 * null if none. Filters by workspace so a sibling VS Code window's
 * heartbeats don't drive the wrong workspace's widget. */
export function readNewestHeartbeat(wsHash: string | null): Heartbeat | null {
  if (!wsHash) return null;
  try {
    if (!existsSync(EH_ROOT_DIR)) return null;
    const files = readdirSync(EH_ROOT_DIR).filter(
      (f) => f.startsWith("turn-heartbeat.") && f.endsWith(".json")
    );
    if (files.length === 0) return null;
    let newest: { parsed: Heartbeat; mtime: number } | null = null;
    for (const f of files) {
      const p = join(EH_ROOT_DIR, f);
      let mtime = 0;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {
        continue;
      }
      if (Date.now() - mtime > HEARTBEAT_STALENESS_MS) continue;
      let raw: string;
      try {
        raw = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      let parsed: Partial<Heartbeat>;
      try {
        parsed = JSON.parse(raw) as Partial<Heartbeat>;
      } catch {
        continue;
      }
      if (parsed.workspaceHash !== wsHash) continue;
      if (typeof parsed.dispatchId !== "string") continue;
      if (!isStage(parsed.stage)) continue;
      const normalized: Heartbeat = {
        dispatchId: parsed.dispatchId,
        target: parsed.target ?? "codex",
        workspacePath: parsed.workspacePath ?? "",
        workspaceHash: parsed.workspaceHash,
        stage: parsed.stage,
        activeTool: parsed.activeTool ?? null,
        toolCallCount:
          typeof parsed.toolCallCount === "number" ? parsed.toolCallCount : 0,
        elapsedMs:
          typeof parsed.elapsedMs === "number" ? parsed.elapsedMs : 0,
        lastProgressAt:
          typeof parsed.lastProgressAt === "number"
            ? parsed.lastProgressAt
            : mtime,
        stageEnteredAt:
          parsed.stageEnteredAt && typeof parsed.stageEnteredAt === "object"
            ? (parsed.stageEnteredAt as Heartbeat["stageEnteredAt"])
            : undefined,
        turnStartedAt:
          typeof parsed.turnStartedAt === "number"
            ? parsed.turnStartedAt
            : undefined,
        waitMode:
          parsed.waitMode === "standard" ||
          parsed.waitMode === "adaptive" ||
          parsed.waitMode === "fire-and-forget"
            ? parsed.waitMode
            : undefined,
      };
      if (!newest || mtime > newest.mtime) {
        newest = { parsed: normalized, mtime };
      }
    }
    return newest?.parsed ?? null;
  } catch {
    return null;
  }
}
