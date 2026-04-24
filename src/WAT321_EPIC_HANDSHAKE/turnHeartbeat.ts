import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EPIC_HANDSHAKE_DIR } from "./constants";

/**
 * Reader for the per-turn heartbeat file the dispatcher writes on
 * every TurnMonitor progress signal. Consumed by the status bar to
 * render the canonical 5-stage display + active-tool tooltip detail
 * during an in-flight bridge turn.
 *
 * Heartbeat path: `~/.wat321/epic-handshake/turn-heartbeat.<envid>.json`.
 * Per-envelope (UUID), so multiple workspaces' concurrent turns each
 * have their own file. The reader filters by workspace hash to pick
 * the right one for the current VS Code window.
 */

export type Stage = "dispatched" | "received" | "working" | "writing" | "complete";

export interface TurnHeartbeat {
  envelopeId: string;
  workspacePath: string;
  workspaceHash: string;
  stage: Stage;
  activeTool: string | null;
  toolCallCount: number;
  elapsedMs: number;
  lastProgressAt: number;
  /** Timestamp (ms epoch) the dispatcher first entered each stage on
   * this turn. Missing keys = stage not yet reached. Drives the
   * static 5-stage tooltip block so each row can show "completed at
   * HH:MM:SS (took 3.2s)" once passed. */
  stageEnteredAt?: Partial<Record<Stage, number>>;
  /** Wall-clock start of the turn so the tooltip can show a single
   * "wait time" counter that ticks up regardless of which stage is
   * active. Set when the dispatcher writes the very first heartbeat. */
  turnStartedAt?: number;
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
      if (
        typeof parsed.envelopeId !== "string" ||
        typeof parsed.stage !== "string"
      ) {
        continue;
      }
      const normalized: TurnHeartbeat = {
        envelopeId: parsed.envelopeId,
        workspacePath: parsed.workspacePath ?? "",
        workspaceHash: parsed.workspaceHash,
        stage: parsed.stage as TurnHeartbeat["stage"],
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

/** Minimum display time per stage before the latch lets the widget
 * advance to the NEXT stage. The latch is a sequential walker: it
 * never skips stages even when the dispatcher's monitor jumps
 * (which happens routinely because Codex emits final_answer and
 * task_complete in the same 5s poll window, so stage 4 never gets
 * a heartbeat write of its own). The walker gives every stage its
 * minimum display time so the user can visually track progress.
 *
 * Per-stage tuning: 3s for all five stages. Under-10s turns stretch
 * the display to ~15s total; over-10s turns see real timing on the
 * longer stages (3/4) because min-hold elapses before we observe
 * the next heartbeat.
 */
const STAGE_LATCH_MS: Record<Stage, number> = {
  dispatched: 3000,
  received: 3000,
  working: 3000,
  writing: 3000,
  complete: 3000,
};

/** Per-stage maximum display time before the walker force-advances
 * one step even when the parser has NOT signaled a higher target
 * stage. Needed because tool-heavy Codex turns spend 80-95% of their
 * wall time emitting `function_call` / `web_search_call` interleaved
 * with `reasoning`, so `parseStageInfo` sits at `working` until the
 * very last `agent_message phase=final_answer`. Without a max-hold
 * the status-bar walker pins at stage 3 for a full minute+, leaving
 * stage 4 essentially invisible.
 *
 * Stages 1 (dispatched) and 5 (complete) are intentionally left at 0
 * (never force-advance): stage 1 is the send/init bookend and should
 * resolve naturally when `task_started` fires; stage 5 is reserved
 * for "reply coming back" and must be driven exclusively by
 * `task_complete` in the rollout so we never claim a turn is done
 * before Codex actually finishes.
 *
 * Stages 2-4 cover Codex's real workload. The max-hold evens out the
 * visible progression so a long turn walks 2 -> 3 -> 4 at reasonable
 * intervals instead of stalling at one stage.
 */
const STAGE_MAX_HOLD_MS: Record<Stage, number> = {
  dispatched: 0, // never force; resolves on task_started
  received: 15_000,
  working: 30_000,
  writing: 0, // holds until task_complete, never force into stage 5
  complete: 0,
};

const STAGE_ORDER_LIST: readonly Stage[] = [
  "dispatched",
  "received",
  "working",
  "writing",
  "complete",
];

function stageIdx(s: Stage): number {
  return STAGE_ORDER_LIST.indexOf(s);
}

interface LatchState {
  envelopeId: string;
  displayedStage: Stage;
  displayedAt: number;
}
let latchState: LatchState | null = null;

/** Apply the per-envelope stage latch. Walks the displayed stage
 * one step at a time toward the heartbeat's real stage, honoring
 * per-stage minimum display time. On a new envelope the walker
 * starts at `dispatched` regardless of what the first heartbeat
 * says, so stage 1 always gets visible time. */
export function applyStageLatch(hb: TurnHeartbeat): TurnHeartbeat {
  const now = Date.now();
  if (!latchState || latchState.envelopeId !== hb.envelopeId) {
    // New turn: always start the walker at `dispatched`, not at
    // whatever stage the heartbeat is already at. The monitor often
    // writes stage=received as the very first heartbeat (because the
    // initial writeHeartbeat("dispatched") in turnRunner happens
    // microseconds before turn/started RPC, and the widget reads the
    // file on its own 1s refresh interval), which would skip the
    // stage 1 display.
    latchState = {
      envelopeId: hb.envelopeId,
      displayedStage: "dispatched",
      displayedAt: now,
    };
    return { ...hb, stage: "dispatched" };
  }
  const displayedIdx = stageIdx(latchState.displayedStage);
  const targetIdx = stageIdx(hb.stage);
  const maxMs = STAGE_MAX_HOLD_MS[latchState.displayedStage];
  const heldMs = now - latchState.displayedAt;
  // Force-advance only when the parser hasn't already signaled a
  // higher target (targetIdx <= displayedIdx), max-hold is set
  // (stages 2-4), the max has elapsed, and a non-terminal next
  // stage exists (never force into `complete`, stage 5 is reserved
  // for reply-back and must be driven by task_complete alone).
  const shouldForceAdvance =
    targetIdx <= displayedIdx &&
    maxMs > 0 &&
    heldMs >= maxMs &&
    displayedIdx + 1 < STAGE_ORDER_LIST.length - 1;
  if (targetIdx <= displayedIdx && !shouldForceAdvance) {
    // Real stage at or below displayed, no force-advance warranted.
    // Keep showing current.
    return { ...hb, stage: latchState.displayedStage };
  }
  // Either the parser's target is ahead, or the max-hold elapsed
  // and a force-advance is due. Respect the min-hold floor so we
  // never flip faster than intended.
  const minMs = STAGE_LATCH_MS[latchState.displayedStage];
  if (heldMs < minMs) {
    return { ...hb, stage: latchState.displayedStage };
  }
  const next = STAGE_ORDER_LIST[displayedIdx + 1];
  latchState = {
    envelopeId: hb.envelopeId,
    displayedStage: next,
    displayedAt: now,
  };
  return { ...hb, stage: next };
}

/** Synthesize a heartbeat for the current envelope even when the
 * dispatcher's heartbeat file has been cleaned up (post-turn). The
 * widget calls this in addition to / instead of reading the file so
 * the stage walker can continue advancing after Codex completes - it
 * would otherwise stall at whatever stage was displayed when the
 * heartbeat file got deleted. Returns null if there's no active
 * envelope to walk. */
export function latchTickNoHeartbeat(envelopeId: string | null): TurnHeartbeat | null {
  if (!envelopeId || !latchState || latchState.envelopeId !== envelopeId) {
    return null;
  }
  // Treat the turn as "complete" for walker target purposes so the
  // latch advances through any remaining stages.
  const synthetic: TurnHeartbeat = {
    envelopeId,
    workspacePath: "",
    workspaceHash: "",
    stage: "complete",
    activeTool: null,
    toolCallCount: 0,
    elapsedMs: 0,
    lastProgressAt: Date.now(),
  };
  return applyStageLatch(synthetic);
}

/** Map a dispatcher-reported stage to the canonical N/5 fraction the
 * status bar tooltip displays. Mirrors `BridgeStage` from
 * `shared/codex-rollout/types` without importing the type so the
 * status-bar layer stays decoupled from the rollout parser. */
export function stageFraction(stage: TurnHeartbeat["stage"]): string {
  switch (stage) {
    case "dispatched":
      return "1/5";
    case "received":
      return "2/5";
    case "working":
      return "3/5";
    case "writing":
      return "4/5";
    case "complete":
      return "5/5";
  }
}

/** Numbered-square glyph for the stage. Drives the status bar icon
 * during adaptive-mode active turns. Matches package.json's
 * `wat321-square-{one..five}` icon font registrations. */
export function stageGlyph(stage: TurnHeartbeat["stage"]): string {
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

/** Static description of what each stage represents. Drives the
 * "what are we waiting for" copy in the static 5-row tooltip block.
 * Plain prose; one short sentence per stage so the user can scan
 * at a glance without parsing technical terms. */
/** One short line per stage so each tooltip row fits without wrapping. */
const STAGE_DESCRIPTIONS: Record<Stage, string> = {
  dispatched: "Bridge dispatching to Codex.",
  received: "Codex accepted; reading your prompt.",
  working: "Codex using tools - searches, files, reasoning.",
  writing: "Codex wrapping up; streaming the reply.",
  complete: "Reply delivered back to Claude.",
};

const STAGE_TITLES: Record<Stage, string> = {
  dispatched: "Sending",
  received: "Received",
  working: "Working",
  writing: "Finalizing",
  complete: "Delivering",
};

const STAGE_ORDER: readonly Stage[] = [
  "dispatched",
  "received",
  "working",
  "writing",
  "complete",
];

/** Build the static 5-row tooltip block. Every row renders regardless
 * of current stage, so the user can always see where the turn is and
 * how long each prior stage took. Format per row:
 *
 *   1/5 Sending - elapsed 1.2s     (active stage)
 *     Envelope written; channel.mjs handed it to the dispatcher.
 *   2/5 Received - completed at 14:32:18 (took 0.8s)   (passed)
 *     Codex acknowledged the turn ...
 *   3/5 Working - pending           (not yet reached)
 *     Codex is doing the work ...
 *
 * Markdown-friendly; consumed by `vscode.MarkdownString` in the
 * status bar tooltip builder. */
export function renderStageTooltipBlock(hb: TurnHeartbeat, now: number): string {
  const lines: string[] = [];
  const enteredAt = hb.stageEnteredAt ?? {};
  const turnStarted = hb.turnStartedAt ?? hb.lastProgressAt;
  const totalElapsed = formatDuration(now - turnStarted);
  lines.push(`Wait time: ${totalElapsed}`);
  lines.push("");

  const currentIdx = STAGE_ORDER.indexOf(hb.stage);
  for (let i = 0; i < STAGE_ORDER.length; i++) {
    const stage = STAGE_ORDER[i];
    const fraction = `${i + 1}/5`;
    const title = STAGE_TITLES[stage];
    const stageStart = enteredAt[stage];

    let stateLine: string;
    if (i < currentIdx) {
      // Passed stage: show completion time + duration.
      const stageEnd = enteredAt[STAGE_ORDER[i + 1]];
      if (stageStart !== undefined && stageEnd !== undefined) {
        const took = formatDuration(stageEnd - stageStart);
        const at = new Date(stageEnd).toLocaleTimeString();
        stateLine = `${fraction} ${title} - completed at ${at} (took ${took})`;
      } else {
        stateLine = `${fraction} ${title} - completed`;
      }
    } else if (i === currentIdx) {
      // Active stage: elapsed-in-stage counter.
      const inStage =
        stageStart !== undefined ? formatDuration(now - stageStart) : "0s";
      stateLine = `${fraction} ${title} - elapsed ${inStage} (active)`;
    } else {
      // Pending stage: just the title.
      stateLine = `${fraction} ${title} - pending`;
    }
    lines.push(stateLine);
    lines.push(`  ${STAGE_DESCRIPTIONS[stage]}`);
  }
  return lines.join("\n");
}

/** Coarse duration formatter for tooltip display. Bucket strategy
 * trades resolution for tooltip-blink reduction: every distinct
 * string the tooltip emits causes VS Code to flash the hover overlay
 * on the next refresh tick (a known MarkdownString limitation we
 * cannot suppress from our side). Buckets:
 *   - 0 ms              -> "0s"
 *   - 1 to 9 sec        -> per-second ("3s")
 *   - 10 to 59 sec      -> 5-second buckets ("15s", "20s")
 *   - 1 to 9 min        -> 30-second buckets ("1m 30s")
 *   - 10+ min           -> minute resolution ("12m")
 * Under 10s the user wants the per-second feedback that "something
 * is happening." Past that, slowdowns are what matter, not exact
 * seconds, so the wider buckets keep the tooltip stable. */
function formatDuration(ms: number): string {
  if (ms < 1000) return "0s";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 10) return `${totalSec}s`;
  if (totalSec < 60) return `${Math.floor(totalSec / 5) * 5}s`;
  const totalMin = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  if (totalMin < 10) {
    const bucketed = Math.floor(remSec / 30) * 30;
    return bucketed === 0 ? `${totalMin}m` : `${totalMin}m ${bucketed}s`;
  }
  return `${totalMin}m`;
}

/** Human-readable label for the heartbeat's stage. Tool name wins
 * over generic "working" - reasoning is often interleaved with tool
 * prep, and the tool name is the more useful UI string. */
export function labelForStage(hb: TurnHeartbeat): string {
  switch (hb.stage) {
    case "dispatched":
      return "Sending";
    case "received":
      return "Received";
    case "working": {
      if (!hb.activeTool) return "Working";
      switch (hb.activeTool) {
        case "update_plan":
          return "Planning";
        case "shell_command":
          return "Researching";
        case "web_search":
        case "web_search_call":
          return "Searching";
        case "read_file":
          return "Reading";
        default:
          return `Using ${hb.activeTool.replace(/_call$/, "").replace(/_/g, " ")}`;
      }
    }
    case "writing":
      return "Finalizing";
    case "complete":
      return "Delivering";
  }
}
