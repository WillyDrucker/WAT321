import { parseLastAssistantText } from "../../shared/codex-rollout/assistantTextParser";
import { extractCurrentTurn } from "../../shared/codex-rollout/phaseParser";
import { parseStageInfo } from "../../shared/codex-rollout/stageInfoParser";
import { readTail } from "../../engine/fs/fileReaders";

/**
 * Codex rollout-recovery primitives for `turnRunner`. Codex's flush
 * latency after a stall/hard-cap interrupt can substantially exceed
 * a single short grace window: a long reply that was mid-stream when
 * the interrupt fired can take seconds to commit its final
 * `task_complete` + `agent_message` to the rollout. A polling loop
 * catches that late commit - a single `setTimeout` would miss it and
 * produce a synthetic "max turn duration" error reply when Codex
 * actually had a real reply one second later.
 *
 * Three windows live here because `runTurnOnce` invokes the poller
 * from distinct paths: stall/hard-cap (generous), `turn/completed`
 * failure (short, the notification already arrived), and the
 * background late-delivery watch. Co-locating the windows, the
 * polling fn, and the parser keeps every recovery decision in one place.
 *
 * Turn-scoping is load-bearing here: `parseStageInfo` and
 * `parseLastAssistantText` are both called on the current-turn slice
 * only. Without that, a failed current turn would happily "recover"
 * with stale assistant text from a prior completed turn in the same
 * rollout - a silent wrong-answer bug.
 */

export interface RecoveryWindow {
  /** Total wall-clock budget before `onTimeout` fires. */
  deadlineMs: number;
  /** Cadence of the stat + tail read inside the window. */
  pollMs: number;
}

/** Recovery after a stall or hard-cap interrupt. Long bridge prompts
 * (multi-thousand-token audits, deep code reads) can need substantially
 * longer than a short flush window before Codex commits its final
 * assistant message, especially when the interrupt arrives mid-stream.
 * 30s is generous enough to catch realistic post-interrupt flushes
 * without keeping the bridge UI frozen indefinitely on a turn that is
 * genuinely stuck. The 1s poll balances reactivity (recovery resolves
 * within a second of Codex finishing its flush) against I/O cost (one
 * stat + tail read per poll, cheap). */
export const INTERRUPT_RECOVERY_WINDOW: RecoveryWindow = {
  deadlineMs: 30_000,
  pollMs: 1_000,
};

/** Tighter window for `turn/completed` failure paths (non-success
 * status, empty items). The notification already arrived, so any
 * rollout-recovery either succeeds quickly or never will - long polling
 * adds latency without payoff. 5s catches the common "items array
 * missing but task_complete already on disk" race without stretching
 * the user's wait. */
export const COMPLETED_TURN_RECOVERY_WINDOW: RecoveryWindow = {
  deadlineMs: 5_000,
  pollMs: 1_000,
};

/** Background late-delivery window. After the initial stall- or
 * hard-cap recovery exhausts, the dispatcher keeps polling the rollout
 * in the background so a long task, mid-turn compact, or slow flush
 * still lands the reply in the inbox via the normal completion path.
 * The MCP tool's caller-side timeout has already returned to the AI
 * by the time this engages - no AI wait is extended - only the
 * extension-side watcher persists. 30 min covers the realistic upper
 * bound of a single Codex turn before declaring it truly stuck, and
 * the 5s poll keeps disk traffic light across that half hour while
 * still catching the reply within one cadence of the write. */
export const LATE_DELIVERY_WINDOW: RecoveryWindow = {
  deadlineMs: 30 * 60_000,
  pollMs: 5_000,
};

/** Single-shot rollout-recovery attempt. Returns the final assistant
 * text when the current-turn slice has both `stage=complete` and a
 * non-empty assistant message - returns null otherwise. The poller
 * below calls this on each tick. */
export function tryRolloutRecovery(rolloutPath: string | null): string | null {
  if (!rolloutPath) return null;
  const tail = readTail(rolloutPath);
  if (!tail) return null;
  const scoped = extractCurrentTurn(tail);
  const info = parseStageInfo(scoped);
  if (info.stage !== "complete") return null;
  const text = parseLastAssistantText(scoped);
  if (!text || text.trim().length === 0) return null;
  return text;
}

interface RecoveryPollOptions {
  window: RecoveryWindow;
  getRolloutPath: () => string | null;
  isSettled: () => boolean;
  /** Optional gate: only resolve with recovered text when it differs
   * from a baseline captured before this turn dispatched. Without
   * this gate, a thread that resumed an earlier completed turn would
   * happily "recover" the prior turn's final answer when our turn
   * never produced one. Undefined means "always fresh". */
  isFreshText?: (text: string) => boolean;
  /** Optional gate: refuse to resolve until our turn was observed
   * starting (via `turn/started` or first delta). Same purpose as
   * `isFreshText` but anchors on the RPC notifications instead of
   * rollout content - belts and suspenders against transport-layer
   * reorderings. Undefined = no constraint. */
  requireTurnObserved?: () => boolean;
  onRecovered: (text: string) => void;
  onTimeout: () => void;
}

/** Poll the rollout for a final assistant message until either recovery
 * succeeds or the deadline elapses. A single-shot grace window would
 * miss a long Codex reply that was mid-stream when the interrupt fired
 * and takes longer than the window to flush - producing a synthetic
 * "max turn duration" error reply when Codex actually had a real reply
 * one second later. The polling loop catches that late commit. */
export function recoverOrRejectViaRolloutPolling(
  opts: RecoveryPollOptions
): void {
  const startedAt = Date.now();
  const { deadlineMs, pollMs } = opts.window;
  const tick = (): void => {
    if (opts.isSettled()) return;
    const recovered = tryRolloutRecovery(opts.getRolloutPath());
    if (recovered !== null) {
      const turnObserved = opts.requireTurnObserved?.() ?? true;
      const fresh = opts.isFreshText?.(recovered) ?? true;
      if (turnObserved && fresh) {
        opts.onRecovered(recovered);
        return;
      }
      // Recovery skipped: the rollout's "current turn" slice belongs
      // to a prior turn that completed before our dispatch (seed text
      // matches, or our turn never started). Keep polling - a fresh
      // turn might still land before the deadline.
    }
    if (Date.now() - startedAt >= deadlineMs) {
      opts.onTimeout();
      return;
    }
    setTimeout(tick, pollMs);
  };
  setTimeout(tick, pollMs);
}
