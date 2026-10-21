import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isBridgeStage } from "../bridgeTypes";
import { EPIC_HANDSHAKE_DIR } from "../wat321Paths";
import type { Heartbeat } from "./heartbeatTypes";

/**
 * Reader for the per-turn heartbeat files `heartbeatWriter.ts` and the
 * MCP runtime's `WAT321_MCP_SERVER/bin/turnHeartbeat.mjs` write under
 * the Epic Handshake root. The bridge stage coordinator drives the 5-stage display from
 * it and the Epic Handshake menu reads it for the in-flight row. Files
 * are per dispatch, so concurrent turns across workspaces each have
 * their own, and the reader filters on `workspaceHash`.
 */

/** A heartbeat older than this is a dead turn: every writer refreshes
 * on each progress signal. */
const HEARTBEAT_STALENESS_MS = 120_000;

function normalizeHeartbeat(
  parsed: Partial<Heartbeat>,
  mtime: number
): Heartbeat | null {
  if (typeof parsed.dispatchId !== "string") return null;
  if (typeof parsed.workspaceHash !== "string") return null;
  if (!isBridgeStage(parsed.stage)) return null;
  return {
    dispatchId: parsed.dispatchId,
    // Every writer stamps a target. A file without one predates that
    // and can only have come from the Codex dispatcher.
    target:
      parsed.target === "opencode" || parsed.target === "local"
        ? parsed.target
        : "codex",
    workspacePath: parsed.workspacePath ?? "",
    workspaceHash: parsed.workspaceHash,
    stage: parsed.stage,
    activeTool: parsed.activeTool ?? null,
    toolCallCount:
      typeof parsed.toolCallCount === "number" ? parsed.toolCallCount : 0,
    elapsedMs: typeof parsed.elapsedMs === "number" ? parsed.elapsedMs : 0,
    lastProgressAt:
      typeof parsed.lastProgressAt === "number" ? parsed.lastProgressAt : mtime,
    stageEnteredAt:
      parsed.stageEnteredAt && typeof parsed.stageEnteredAt === "object"
        ? parsed.stageEnteredAt
        : undefined,
    turnStartedAt:
      typeof parsed.turnStartedAt === "number" ? parsed.turnStartedAt : undefined,
    waitMode:
      parsed.waitMode === "standard" ||
      parsed.waitMode === "adaptive" ||
      parsed.waitMode === "fire-and-forget"
        ? parsed.waitMode
        : undefined,
  };
}

/** The freshest live heartbeat for the workspace, or null.
 *
 * Workspace filtering matters when multiple VS Code windows run the
 * bridge concurrently - without it the status bar in window A would
 * render whatever turn is freshest in window B.
 *
 * `preferredDispatchId`: when an active latch already owns a turn,
 * pass its id so the reader returns that turn's heartbeat even when a
 * parallel backend (an OpenCode or Local fire-and-forget dispatch) has
 * just written a fresher file for a different dispatch. Without this,
 * parallel dispatches make the single-latch coordinator flip between
 * turns and the Codex ceremony visibly replays. */
export function readNewestHeartbeat(
  wsHash: string | null,
  preferredDispatchId?: string
): Heartbeat | null {
  if (!wsHash) return null;
  try {
    if (!existsSync(EPIC_HANDSHAKE_DIR)) return null;
    const files = readdirSync(EPIC_HANDSHAKE_DIR).filter(
      (f) => f.startsWith("turn-heartbeat.") && f.endsWith(".json")
    );
    const now = Date.now();
    let newest: { beat: Heartbeat; mtime: number } | null = null;
    let preferred: Heartbeat | null = null;
    for (const f of files) {
      const path = join(EPIC_HANDSHAKE_DIR, f);
      let mtime = 0;
      let raw: string;
      try {
        mtime = statSync(path).mtimeMs;
        if (now - mtime > HEARTBEAT_STALENESS_MS) continue;
        raw = readFileSync(path, "utf8");
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
      const beat = normalizeHeartbeat(parsed, mtime);
      if (beat === null) continue;
      if (!newest || mtime > newest.mtime) newest = { beat, mtime };
      if (preferredDispatchId !== undefined && beat.dispatchId === preferredDispatchId) {
        preferred = beat;
      }
    }
    return preferred ?? newest?.beat ?? null;
  } catch {
    return null;
  }
}
