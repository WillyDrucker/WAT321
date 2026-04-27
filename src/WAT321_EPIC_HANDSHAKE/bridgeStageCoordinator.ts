import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type {
  BridgePhase,
  BridgeStage,
  BridgeStageReader,
  BridgeStageSnapshot,
} from "../engine/bridgeTypes";
import type { EventHub } from "../engine/eventHub";
import { returningFlagPath } from "./constants";
import { isBridgeBusy, isPaused } from "./statusBarState";
import {
  readNewestHeartbeat,
  type TurnHeartbeat,
} from "./turnHeartbeat";
import { workspaceHash } from "./workspaceHash";

/**
 * Single source of truth for Epic Handshake bridge state across the
 * status bar surface. The bridge widget, Claude session tokens, and
 * Codex session tokens all read `snapshot()` and observe the same
 * latched stage at the same wall-clock instant - no drift, no parallel
 * ceremony timers, no widget showing stage 3 while another still plays
 * the debug-disconnect ceremony.
 *
 * Discipline:
 *   - Owns all bridge timing constants (per-stage min/max holds,
 *     ceremony duration). Widgets render based on snapshot fields,
 *     not their own clock math.
 *   - Self-driven 1Hz polling. Snapshot is recomputed on every tick;
 *     consumers either read snapshot() lazily (inside their own
 *     250ms / 1s render loops) or subscribe to phase/stage events
 *     for instant-on-change reactions.
 *   - Module-private latch state. External code cannot mutate it,
 *     only observe via snapshot.
 *
 * Lives in the EH tier because bridge state is single-tool, not
 * cross-cutting. Engine owns the type contract + event surface
 * (`bridgeTypes.ts`, `eventHub.ts`); the EH tier owns the
 * implementation and lifecycle.
 *
 * Stage map - what each square-N cycle means:
 *
 *   1 dispatched   square-one   <-> arrow-right   outbound to Codex
 *     Codex side:  app-server child spawning OR thread/start +
 *                  turn/start being dialed in. Pre-warm at activate
 *                  collapses the spawn portion to zero on first
 *                  dispatch; without pre-warm this can run ~20s.
 *     Entry:       writeHeartbeat("dispatched") fires immediately
 *                  when turnRunner starts the turn.
 *     Exit:        observeRpcProgress("turn-started") on JSON-RPC
 *                  notification, OR pollRollout sees task_started.
 *     Force-exit:  30s ceiling - if neither signal fires the walker
 *                  synthetically advances so the user sees motion.
 *
 *   2 received     square-two   <-> arrow-right   prompt accepted
 *     Codex side:  initial reasoning before any tool call - reading
 *                  the prompt, planning approach. Pure-text "early
 *                  reasoning" entries land here.
 *     Entry:       task_started rollout event OR turn/started RPC.
 *     Exit:        first function_call / web_search_call response
 *                  item, OR force-advance after 15s.
 *
 *   3 working      square-three <-> blank          Codex working
 *     Codex side:  active tool use (web_search_call, function_call,
 *                  shell, file IO). 80-95% of wall time on tool-heavy
 *                  research turns.
 *     Entry:       first function_call or web_search_call entry.
 *     Exit:        agent_message phase=final_answer OR post-tool
 *                  reasoning threshold (>=2 reasoning entries after
 *                  the last tool output) OR force-advance after 30s.
 *
 *   4 writing      square-four  <-> blank          composing answer
 *   4 + returning  square-four  <-> arrow-left     reply imminent
 *     Codex side:  final assistant message text being produced.
 *     Entry:       agent_message phase=final_answer OR the post-tool
 *                  reasoning heuristic.
 *     Exit:        task_complete rollout event. No force-advance -
 *                  stage 5 is reserved for genuine completion.
 *
 *   5 complete     square-five  <-> arrow-left     delivered back
 *     Codex side:  turn done, bridge writing the reply envelope to
 *                  Claude's inbox.
 *     Entry:       task_complete rollout event OR turn/completed RPC.
 *     Exit:        held 3s + COMPLETE_WALK_HOLD_MS so the user sees
 *                  at least one full cycle, then widget transitions
 *                  to the returning-arrow handoff animation.
 */

/** Minimum display time per stage before the latch lets the walker
 * advance to the NEXT stage. Sequential walker - never skips stages
 * even when the dispatcher's monitor jumps (which happens routinely
 * because Codex emits final_answer and task_complete in the same 5s
 * poll window, so stage 4 never gets a heartbeat write of its own).
 * Stage 1 (dispatched) gets the longest floor so two full 1Hz cycles
 * of the square-one <-> arrow-right blink are always visible. */
const STAGE_LATCH_MS: Record<BridgeStage, number> = {
  dispatched: 4000,
  received: 3000,
  working: 3000,
  writing: 3000,
  complete: 3000,
};

/** Per-stage maximum display time before the walker force-advances
 * one step even when the parser has NOT signaled a higher target
 * stage. Tool-heavy Codex turns spend 80-95% of their wall time on
 * function_call / web_search_call interleaved with reasoning, so the
 * parser can sit at `working` until the very last `agent_message
 * phase=final_answer`. Without a max-hold the walker pins at stage 3
 * for a minute+, leaving stage 4 essentially invisible.
 *
 * Stage 1 (dispatched) ceiling guards against codex app-server cold
 * start where neither `turn/started` RPC nor a rollout file exists
 * yet. Pre-warm at activate normally drops this to <2s, but the
 * 30s ceiling stays as a defensive net so the user always sees the
 * walker move past stage 1 on a turn that ultimately succeeds.
 *
 * Stage 5 (complete) intentionally left at 0: must be driven by
 * `task_complete` in the rollout so we never claim a turn is done
 * before Codex actually finishes. */
const STAGE_MAX_HOLD_MS: Record<BridgeStage, number> = {
  dispatched: 30_000,
  received: 15_000,
  working: 30_000,
  writing: 0,
  complete: 0,
};

/** Debug-disconnect/connected ceremony duration after `turnStartedAt`.
 * Drives the `phase: "ceremony"` window during which session token
 * widgets render the debug ceremony glyphs. Aligned with stage 1's
 * min-hold so both widgets agree on when the ceremony ends. */
const CEREMONY_MS = 4000;

/** Backstop polling interval. fs-watch on the EH directory drives
 * most ticks instantly off heartbeat/flag/envelope writes; the timer
 * remains for time-based progressions (ceremony window expiring,
 * stage min-hold elapsing while the dispatcher is silent). */
const TICK_INTERVAL_MS = 1000;

/** How long the coordinator has to stay idle before the polling
 * timer suspends itself. fs-watch keeps state correct - the timer
 * only matters when the dispatcher is actively walking through
 * stages, so suspending it during long idle stretches saves the
 * 1Hz fs op cost without losing reactivity. The next fs-watch
 * event resumes the timer immediately. */
const IDLE_SUSPEND_MS = 30_000;

/** Coalesce fs-watch fire bursts. Atomic writes (tmp + rename) trigger
 * 2-3 events in rapid succession; without debouncing the coordinator
 * would tick 3x per envelope write for no display difference. 50ms is
 * tight enough to feel instant and wide enough to absorb the burst. */
const WATCH_DEBOUNCE_MS = 50;

const EH_DIR = join(homedir(), ".wat321", "epic-handshake");

/** How long after a synthetic walker reaches `complete` before we
 * release the envelope tracking and let the widget transition to the
 * returning-arrow handoff animation. Keeps stage 5 visible briefly
 * even after the dispatcher's heartbeat file has been removed. */
const COMPLETE_WALK_HOLD_MS = 3000;

const STAGE_ORDER: readonly BridgeStage[] = [
  "dispatched",
  "received",
  "working",
  "writing",
  "complete",
];

function stageIdx(s: BridgeStage): number {
  return STAGE_ORDER.indexOf(s);
}

interface LatchState {
  envelopeId: string;
  displayedStage: BridgeStage;
  displayedAt: number;
  /** Wall-clock when the underlying turn started (`turnStartedAt`
   * from the heartbeat). Used for ceremony detection. Falls back to
   * latch entry if the heartbeat does not carry a turn start. */
  turnStartedAt: number;
  /** Set when the synthetic walker (post-heartbeat-cleanup path)
   * reaches `complete`; lets the coordinator hold stage 5 briefly
   * before clearing the envelope so the widget can render the
   * post-turn handoff animation cleanly. */
  completeWalkAt: number | null;
  /** Highest stage seen on this envelope's heartbeat across all
   * snapshot reads. Lets the walker keep advancing toward "complete"
   * after the heartbeat file is unlinked or the in-flight flag is
   * cleared - both of which the dispatcher does at turn end while
   * the walker is still walking through stages. Without this field
   * the walker's target signal disappears the moment the dispatcher
   * declares the turn done, and stages 4-5 commonly never display. */
  lastTargetStage: BridgeStage;
  /** Wall-clock when the heartbeat file first became unreadable on
   * this envelope. Drives the orphan-grace timeout: a latch whose
   * heartbeat has been gone for LATCH_ORPHAN_GRACE_MS AND has not
   * committed to a "complete" target is treated as an aborted turn
   * (cancel, error) and dropped. Reset to null whenever a fresh
   * heartbeat read succeeds. */
  lostHeartbeatAt: number | null;
}

/** Grace window before dropping a latch whose heartbeat has gone
 * missing AND whose lastTargetStage is not yet `complete`. Covers
 * the cancel / bridge-error path where the dispatcher tears down
 * the heartbeat without ever writing stage=complete. With a target
 * of complete the walker honors it regardless of grace. */
const LATCH_ORPHAN_GRACE_MS = 3000;

/** Compressed min-hold for intermediate stages (received, working,
 * writing) when Codex has already finished and the walker just needs
 * to catch up to the actual end-state. Triggered when lastTargetStage
 * reaches "complete" while the walker is still walking. Stage 1
 * (dispatched) keeps its full 4s ceremony floor regardless - the
 * debug ceremony on session-token widgets needs that window. Stage 5
 * (complete) keeps its full 3s + COMPLETE_WALK_HOLD_MS so the
 * delivery cycle reads cleanly. The 500ms intermediate lets stages
 * 3 and 4 each get a visible flash on a sub-12s "fast" turn instead
 * of being skipped invisibly under the latched walker pacing. */
const FAST_WALK_INTERMEDIATE_MS = 500;

const IDLE_SNAPSHOT: BridgeStageSnapshot = {
  workspacePath: null,
  phase: "idle",
  latchedStage: null,
  msInStage: 0,
  ceremonyActive: false,
  returning: false,
  paused: false,
  heartbeat: null,
};

export class BridgeStageCoordinator
  implements vscode.Disposable, BridgeStageReader
{
  private latchState: LatchState | null = null;
  private lastSnapshot: BridgeStageSnapshot = IDLE_SNAPSHOT;
  private interval: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Wall-clock when the coordinator last observed a non-idle phase.
   * Drives the idle-suspend optimization: when no activity has
   * happened for `IDLE_SUSPEND_MS`, the polling timer pauses itself
   * (fs-watch keeps state correct without it). The next fs-watch
   * event or a manual tick() call restarts the timer. */
  private lastNonIdleAt = Date.now();

  constructor(private readonly events: EventHub) {}

  /** Begin self-driven monitoring. Idempotent - second call no-ops.
   * Sets up:
   *   1. A 1s polling timer as backstop (ceremony window expiry,
   *      heartbeat staleness checks during dispatcher silence). The
   *      timer suspends itself after `IDLE_SUSPEND_MS` of nothing
   *      happening; fs-watch resumes it on the next state change.
   *   2. An fs-watch on `~/.wat321/epic-handshake/` so heartbeat
   *      writes, flag flips, and envelope arrivals trigger an
   *      immediate tick - widgets reflect the change in <100ms
   *      instead of waiting for the next 1s poll. */
  start(): void {
    if (this.interval !== null) return;
    this.tick();
    this.resumeTimer();
    this.attachWatcher();
  }

  /** Start the polling timer if not already running. Called from
   * start() and from the fs-watch debounce handler when activity
   * resumes after an idle suspension. */
  private resumeTimer(): void {
    if (this.interval !== null) return;
    this.interval = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  /** Pause the polling timer. fs-watch + the lastNonIdleAt tracker
   * resume it the moment activity returns. */
  private suspendTimer(): void {
    if (this.interval === null) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  /** Lazy-attach fs.watch on EH_DIR. The directory is created by the
   * Epic Handshake tier on activate; if it doesn't exist yet we'll
   * try again on the next tick that observes a missing dir. Watch
   * failure is non-fatal - the polling timer keeps state fresh
   * regardless. */
  private attachWatcher(): void {
    if (this.watcher !== null) return;
    if (!existsSync(EH_DIR)) {
      // Will retry on subsequent ticks once the EH tier creates it.
      return;
    }
    try {
      this.watcher = watch(EH_DIR, { persistent: false }, () => {
        // Coalesce bursts of writes (atomic tmp+rename triggers 2-3
        // events). Single delayed tick captures the final state.
        if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          // Activity returned: resume the polling timer in case it
          // suspended itself during a long idle stretch. tick() will
          // re-record lastNonIdleAt if the new state is non-idle.
          this.resumeTimer();
          this.tick();
        }, WATCH_DEBOUNCE_MS);
      });
      this.watcher.on("error", () => {
        // Best-effort: if the watcher errors out (e.g. dir deleted),
        // detach so attachWatcher can retry on a future tick.
        this.detachWatcher();
      });
    } catch {
      // Some filesystems (network mounts, certain Windows volumes)
      // reject fs.watch. Polling-only fallback is still correct,
      // just slower to react.
      this.watcher = null;
    }
  }

  private detachWatcher(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher !== null) {
      try {
        this.watcher.close();
      } catch {
        // best-effort
      }
      this.watcher = null;
    }
  }

  /** Recompute the snapshot from current heartbeat + flag state.
   * Emits `bridge.phaseChanged` and `bridge.stageChanged` on transitions.
   * Called automatically by the polling timer + the fs-watch debounce;
   * external callers can tick manually if they need to react before
   * the next 1s window or fs event. Also retries fs-watch attach if
   * the EH directory has appeared since startup. */
  tick(): BridgeStageSnapshot {
    if (this.watcher === null) this.attachWatcher();
    const next = this.compute();
    const prev = this.lastSnapshot;
    this.lastSnapshot = next;
    if (prev.phase !== next.phase) {
      this.events.emit("bridge.phaseChanged", {
        from: prev.phase,
        to: next.phase,
        workspacePath: next.workspacePath,
      });
    }
    if (prev.latchedStage !== next.latchedStage) {
      this.events.emit("bridge.stageChanged", {
        from: prev.latchedStage,
        to: next.latchedStage,
        workspacePath: next.workspacePath,
      });
    }
    // Idle-suspend: when nothing has been happening for a while,
    // pause the polling timer. fs-watch will resume it on the next
    // state-affecting file event. Saves the 1Hz fs op cost during
    // long stretches of bridge inactivity.
    const now = Date.now();
    if (next.phase !== "idle") {
      this.lastNonIdleAt = now;
    } else if (now - this.lastNonIdleAt >= IDLE_SUSPEND_MS) {
      this.suspendTimer();
    }
    return next;
  }

  /** Read the most recent snapshot without recomputing. Cheap; safe
   * to call from animation frames at any cadence. */
  snapshot(): BridgeStageSnapshot {
    return this.lastSnapshot;
  }

  dispose(): void {
    this.suspendTimer();
    this.detachWatcher();
    this.latchState = null;
    this.lastSnapshot = IDLE_SNAPSHOT;
  }

  private compute(): BridgeStageSnapshot {
    const workspacePath =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    if (workspacePath === null) {
      this.latchState = null;
      return { ...IDLE_SNAPSHOT, workspacePath: null };
    }

    const paused = isPaused();
    if (paused) {
      // Paused state preempts everything else; the bridge widget
      // renders the pause glyph regardless of latch state.
      this.latchState = null;
      return {
        ...IDLE_SNAPSHOT,
        workspacePath,
        paused: true,
      };
    }

    const wsHash = workspaceHash(workspacePath);
    const returning = existsSync(returningFlagPath(wsHash));
    const rawHeartbeat = readNewestHeartbeat(wsHash);
    const busy = isBridgeBusy(workspacePath);
    const now = Date.now();

    // Walker-owned phase. An active latch has its own life cycle
    // independent of the in-flight flag and the heartbeat file -
    // both of which the dispatcher tears down at turn-end while the
    // walker may still have stages to display. The latch persists
    // until the walker has either:
    //   (a) reached `complete` and held for COMPLETE_WALK_HOLD_MS
    //       (natural end - applyLatch returns null and clears latch
    //       internally), or
    //   (b) been orphaned (no heartbeat AND target < complete) for
    //       LATCH_ORPHAN_GRACE_MS (cancel / bridge-error path).
    if (this.latchState !== null) {
      // Refresh target tracking from the current heartbeat read.
      if (
        rawHeartbeat !== null &&
        rawHeartbeat.envelopeId === this.latchState.envelopeId
      ) {
        const hbIdx = stageIdx(rawHeartbeat.stage);
        const tgtIdx = stageIdx(this.latchState.lastTargetStage);
        if (hbIdx > tgtIdx) {
          this.latchState.lastTargetStage = rawHeartbeat.stage;
        }
        this.latchState.lostHeartbeatAt = null;
      } else if (this.latchState.lostHeartbeatAt === null) {
        this.latchState.lostHeartbeatAt = now;
      }

      // Orphan-grace check: if no heartbeat and target hasn't reached
      // complete after the grace window, this is a cancelled / errored
      // turn - drop the latch and fall through to idle.
      const orphaned =
        this.latchState.lostHeartbeatAt !== null &&
        this.latchState.lastTargetStage !== "complete" &&
        now - this.latchState.lostHeartbeatAt >= LATCH_ORPHAN_GRACE_MS;
      if (orphaned) {
        this.latchState = null;
      } else {
        // Walker continues. Synthesize a heartbeat from cached state
        // when the real one is unreadable so applyLatch always has a
        // target (the lastTargetStage tracked above).
        const hbForLatch: TurnHeartbeat =
          rawHeartbeat !== null &&
          rawHeartbeat.envelopeId === this.latchState.envelopeId
            ? rawHeartbeat
            : {
                envelopeId: this.latchState.envelopeId,
                workspacePath,
                workspaceHash: wsHash,
                stage: this.latchState.lastTargetStage,
                activeTool: null,
                toolCallCount: 0,
                elapsedMs: now - this.latchState.turnStartedAt,
                lastProgressAt: now,
                turnStartedAt: this.latchState.turnStartedAt,
              };

        const latched = this.applyLatch(hbForLatch);
        if (latched !== null) {
          const turnStartedAt = this.latchState
            ? this.latchState.turnStartedAt
            : (hbForLatch.turnStartedAt ?? now);
          const ceremonyActive = now - turnStartedAt < CEREMONY_MS;
          return {
            workspacePath,
            phase: ceremonyActive ? "ceremony" : "stage",
            latchedStage: latched,
            msInStage: this.latchState
              ? now - this.latchState.displayedAt
              : 0,
            ceremonyActive,
            returning,
            paused: false,
            heartbeat: rawHeartbeat,
          };
        }
        // applyLatch returned null - walker fully done, latch already
        // cleared. Fall through to the post-walk path.
      }
    }

    // No active latch. If a fresh heartbeat is in for a busy bridge,
    // start a new latch at stage 1.
    if (busy && rawHeartbeat !== null) {
      const latched = this.applyLatch(rawHeartbeat);
      if (latched !== null) {
        const turnStartedAt = this.latchState?.turnStartedAt ?? now;
        const ceremonyActive = now - turnStartedAt < CEREMONY_MS;
        return {
          workspacePath,
          phase: ceremonyActive ? "ceremony" : "stage",
          latchedStage: latched,
          msInStage: this.latchState
            ? now - this.latchState.displayedAt
            : 0,
          ceremonyActive,
          returning,
          paused: false,
          heartbeat: rawHeartbeat,
        };
      }
    }

    if (busy) {
      // Bridge busy but no heartbeat yet. Pre-ceremony window where
      // session-token widgets render queue-latency animations.
      return {
        workspacePath,
        phase: "pre-ceremony",
        latchedStage: null,
        msInStage: 0,
        ceremonyActive: false,
        returning,
        paused: false,
        heartbeat: null,
      };
    }

    // Idle: no walker, no busy flag.
    return {
      ...IDLE_SNAPSHOT,
      workspacePath,
      returning,
      heartbeat: rawHeartbeat,
    };
  }

  private applyLatch(hb: TurnHeartbeat): BridgeStage | null {
    const now = Date.now();
    if (
      this.latchState === null ||
      this.latchState.envelopeId !== hb.envelopeId
    ) {
      // New envelope: walker always starts at `dispatched` so stage 1
      // gets visible time. The monitor often writes stage=received as
      // its first heartbeat (because writeHeartbeat("dispatched") in
      // turnRunner happens microseconds before turn/started RPC and
      // the coordinator reads on its 1s tick), which would otherwise
      // skip the stage 1 display.
      this.latchState = {
        envelopeId: hb.envelopeId,
        displayedStage: "dispatched",
        displayedAt: now,
        turnStartedAt: hb.turnStartedAt ?? now,
        completeWalkAt: null,
        lastTargetStage: hb.stage,
        lostHeartbeatAt: null,
      };
      return "dispatched";
    }

    const displayedIdx = stageIdx(this.latchState.displayedStage);
    const targetIdx = stageIdx(hb.stage);
    const heldMs = now - this.latchState.displayedAt;
    const minMs = STAGE_LATCH_MS[this.latchState.displayedStage];
    const maxMs = STAGE_MAX_HOLD_MS[this.latchState.displayedStage];

    // Force-advance only when: parser has NOT already signaled a
    // higher target, max-hold is set (stages 2-4 only), max elapsed,
    // and a non-terminal next stage exists (never auto-step into
    // `complete` - stage 5 is reserved for task_complete signaling).
    const shouldForceAdvance =
      targetIdx <= displayedIdx &&
      maxMs > 0 &&
      heldMs >= maxMs &&
      displayedIdx + 1 < STAGE_ORDER.length - 1;

    if (targetIdx <= displayedIdx && !shouldForceAdvance) {
      // Track the synthetic-walker complete-hold window. Once the
      // coordinator is fed a synthetic `complete` (heartbeat file
      // gone, but envelope still tracked), hold stage 5 visible for
      // COMPLETE_WALK_HOLD_MS before releasing the envelope.
      if (
        this.latchState.displayedStage === "complete" &&
        this.latchState.completeWalkAt === null
      ) {
        this.latchState.completeWalkAt = now;
      }
      if (
        this.latchState.completeWalkAt !== null &&
        now - this.latchState.completeWalkAt >= COMPLETE_WALK_HOLD_MS
      ) {
        // Release the envelope - widget transitions to returning /
        // delivered animation outside the coordinator.
        this.latchState = null;
        return null;
      }
      return this.latchState.displayedStage;
    }

    // Either the parser's target is ahead, or the max-hold elapsed
    // and a force-advance is due. Respect the min-hold floor so we
    // never flip faster than intended.
    //
    // Fast-walk: when the walker knows the turn is fully done
    // (lastTargetStage === complete) but is still walking through
    // intermediate stages 2/3/4, compress their min-hold to 500ms
    // so the user reaches stage 5 in ~1.5s instead of ~9s. Stages 1
    // and 5 keep their full holds so the bookend ceremonies read
    // cleanly even on a fast turn.
    const targetIsComplete =
      stageIdx(this.latchState.lastTargetStage) ===
      stageIdx("complete");
    const fastWalkApplies =
      targetIsComplete &&
      (this.latchState.displayedStage === "received" ||
        this.latchState.displayedStage === "working" ||
        this.latchState.displayedStage === "writing");
    const effectiveMinMs = fastWalkApplies ? FAST_WALK_INTERMEDIATE_MS : minMs;
    if (heldMs < effectiveMinMs) {
      return this.latchState.displayedStage;
    }

    const next = STAGE_ORDER[displayedIdx + 1];
    const tgtIdx = stageIdx(hb.stage);
    const carriedTargetIdx = stageIdx(this.latchState.lastTargetStage);
    const newLastTarget =
      tgtIdx > carriedTargetIdx ? hb.stage : this.latchState.lastTargetStage;
    this.latchState = {
      envelopeId: hb.envelopeId,
      displayedStage: next,
      displayedAt: now,
      turnStartedAt: this.latchState.turnStartedAt,
      completeWalkAt: null,
      lastTargetStage: newLastTarget,
      lostHeartbeatAt: this.latchState.lostHeartbeatAt,
    };
    return next;
  }
}
