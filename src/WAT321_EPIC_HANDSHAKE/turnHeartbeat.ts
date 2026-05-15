import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EPIC_HANDSHAKE_DIR } from "./constants";
import type { WaitMode } from "./waitMode";

/**
 * Reader for the per-turn heartbeat file the dispatcher writes on
 * every TurnMonitor progress signal. Consumed by `bridgeStageCoordinator`
 * to compute the canonical 5-stage display + active-tool tooltip detail
 * during an in-flight bridge turn, and by `statusBarItem` for the
 * adaptive-mode glyph cycle.
 *
 * Heartbeat path: `~/.wat321/epic-handshake/turn-heartbeat.<envid>.json`.
 * Per-envelope (UUID), so multiple workspaces' concurrent turns each
 * have their own file. The reader filters by workspace hash to pick
 * the right one for the current VS Code window.
 */

export type Stage = "dispatched" | "received" | "working" | "writing" | "complete";

const VALID_STAGES: ReadonlySet<Stage> = new Set<Stage>([
  "dispatched",
  "received",
  "working",
  "writing",
  "complete",
]);

/** Validate a string against the Stage union. Defends the coordinator
 * against a heartbeat file containing an unknown stage value (CLI
 * upgrade lag, manually-edited heartbeat for debugging, partial write
 * landed before the writer rewrote the field). Without the guard, an
 * unknown stage flows into `STAGE_ORDER.indexOf` which returns -1 and
 * trips downstream `STAGE_LATCH_MS[stage]` lookups with `undefined`. */
function isStage(value: unknown): value is Stage {
  return typeof value === "string" && VALID_STAGES.has(value as Stage);
}

export type BridgeTarget = "codex" | "opencode" | "local";

export interface TurnHeartbeat {
  envelopeId: string;
  /** Backend that produced this heartbeat. Codex / OpenCode / Local
   * each write their own heartbeats; the session-token widgets read
   * this to skip the debug-connect ceremony for off-target dispatches
   * (the Codex widget should NOT animate when a Big Pickle FF call
   * is in flight). Optional for back-compat with older heartbeat
   * files that predate the unified engine writer - missing = "codex"
   * (the only writer at the time those files were produced). */
  target?: BridgeTarget;
  workspacePath: string;
  workspaceHash: string;
  stage: Stage;
  activeTool: string | null;
  toolCallCount: number;
  elapsedMs: number;
  lastProgressAt: number;
  /** Timestamp (ms epoch) the dispatcher first entered each stage on
   * this turn. Missing keys = stage not yet reached. */
  stageEnteredAt?: Partial<Record<Stage, number>>;
  /** Wall-clock start of the turn so consumers can show a single
   * "wait time" counter that ticks up regardless of which stage is
   * active. Set when the dispatcher writes the very first heartbeat. */
  turnStartedAt?: number;
  /** Wait mode the dispatcher is running this turn under. Drives the
   * Claude session-tokens widget animation gate (FF bypasses the
   * bridge ceremony). Without carrying this on the heartbeat the
   * widget can only read the sticky flag, which lags behind per-call
   * args passed to `wat321_ask`. Optional for back-compat with older
   * dispatchers; absent means fall back to the flag. */
  waitMode?: WaitMode;
}

const HEARTBEAT_STALENESS_MS = 120_000;

/** Read the newest heartbeat matching the given workspace hash, or
 * null if none exists / the newest matching one is older than 2
 * minutes (dispatcher refreshes on every progress signal so older
 * files are dead turns).
 *
 * Workspace filtering matters when multiple VS Code windows run the
 * bridge concurrently - without it the status bar in window A
 * would render whatever turn is freshest in window B. */
export function readNewestHeartbeat(wsHash: string | null): TurnHeartbeat | null {
  if (!wsHash) return null;
  try {
    if (!existsSync(EPIC_HANDSHAKE_DIR)) return null;
    const files = readdirSync(EPIC_HANDSHAKE_DIR).filter(
      (f) => f.startsWith("turn-heartbeat.") && f.endsWith(".json")
    );
    if (files.length === 0) return null;
    let newest: { parsed: TurnHeartbeat; mtime: number } | null = null;
    for (const f of files) {
      const p = join(EPIC_HANDSHAKE_DIR, f);
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
      let parsed: Partial<TurnHeartbeat>;
      try {
        parsed = JSON.parse(raw) as Partial<TurnHeartbeat>;
      } catch {
        continue;
      }
      if (parsed.workspaceHash !== wsHash) continue;
      // Engine-tier dispatchers (non-Codex) write the per-turn id as
      // `dispatchId`; the Codex dispatcher (which predates the unified
      // engine) writes it as `envelopeId`. Both name the same UUID -
      // accept either so the bridge stage coordinator sees every
      // backend's heartbeat through a single reader.
      const heartbeatId =
        typeof parsed.envelopeId === "string"
          ? parsed.envelopeId
          : typeof (parsed as { dispatchId?: unknown }).dispatchId === "string"
            ? ((parsed as { dispatchId: string }).dispatchId)
            : null;
      if (heartbeatId === null) continue;
      if (!isStage(parsed.stage)) continue;
      const normalized: TurnHeartbeat = {
        envelopeId: heartbeatId,
        target:
          parsed.target === "opencode" ||
          parsed.target === "local" ||
          parsed.target === "codex"
            ? parsed.target
            : undefined,
        workspacePath: parsed.workspacePath ?? "",
        workspaceHash: parsed.workspaceHash,
        stage: parsed.stage,
        activeTool: parsed.activeTool ?? null,
        toolCallCount:
          typeof parsed.toolCallCount === "number" ? parsed.toolCallCount : 0,
        elapsedMs: typeof parsed.elapsedMs === "number" ? parsed.elapsedMs : 0,
        lastProgressAt:
          typeof parsed.lastProgressAt === "number"
            ? parsed.lastProgressAt
            : mtime,
        stageEnteredAt:
          parsed.stageEnteredAt && typeof parsed.stageEnteredAt === "object"
            ? (parsed.stageEnteredAt as TurnHeartbeat["stageEnteredAt"])
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

/** Numbered-square glyph for the stage. Drives the status bar icon
 * during adaptive-mode active turns. Matches package.json's
 * `wat321-square-{one..five}` icon font registrations. */
export function stageGlyph(stage: Stage): string {
  switch (stage) {
    case "dispatched":
      return "$(wat321-square-one)";
    case "received":
      return "$(wat321-square-two)";
    case "working":
      return "$(wat321-square-three)";
    case "writing":
      return "$(wat321-square-four)";
    case "complete":
      return "$(wat321-square-five)";
  }
}

/** 1Hz cycle frame for adaptive mode. Alternates the numbered stage
 * glyph (even seconds) with a directional or neutral frame (odd
 * seconds) so the status bar reads as motion + direction across the
 * lifecycle:
 *
 *   1 dispatched   square-one   <-> arrow-right   (outbound)
 *   2 received     square-two   <-> arrow-right   (outbound)
 *   3 working      square-three <-> blank         (Codex thinking)
 *   4 writing      square-four  <-> blank         (still composing)
 *   4 + returning  square-four  <-> arrow-left    (reply incoming)
 *   5 complete     square-five  <-> arrow-left    (delivered back)
 *
 * The 4a/4b split uses the dispatcher's `returning.<wsHash>.flag` so
 * we get a "delivery imminent" cue without a new heartbeat field. */
export function adaptiveStageCycle(
  stage: Stage,
  oneHz: boolean,
  returning: boolean
): string {
  if (oneHz) return stageGlyph(stage);
  switch (stage) {
    case "dispatched":
    case "received":
      return "$(wat321-square-arrow-right)";
    case "working":
      return "$(wat321-square)";
    case "writing":
      return returning ? "$(wat321-square-arrow-left)" : "$(wat321-square)";
    case "complete":
      return "$(wat321-square-arrow-left)";
  }
}
