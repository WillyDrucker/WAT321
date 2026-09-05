import type { AppServerClient } from "../appServer/appServerClient";
import type { Envelope } from "./envelope";
import type { EpicHandshakeLogger } from "../epicHandshakeLogger";
import type { TurnInterruptParams } from "../appServer/protocol";
import {
  COMPLETED_TURN_RECOVERY_WINDOW,
  INTERRUPT_RECOVERY_WINDOW,
  LATE_DELIVERY_WINDOW,
  recoverOrRejectViaRolloutPolling,
  type RecoveryWindow,
} from "./rolloutRecovery";
import { findRolloutPath } from "./sessionRecovery";
import { accumulateDelta, assembleTurnReply, type TurnCompleted } from "./turnCompletion";
import { writeProcessingFlag, writeSuppressCodexToast } from "./turnFlags";
import { createHeartbeatWriter } from "./turnHeartbeatWriter";
import { TurnMonitor } from "./turnMonitor";
import type { RpcProgressKind } from "./turnMonitorOptions";
import { createFreshnessGate } from "./turnRecovery";
import { buildTurnStartParams } from "./turnStartParams";
import { attachTurnWatchers } from "./turnWatchers";
import type { WaitMode } from "./waitMode";

/**
 * One-shot Codex turn execution. Subscribes to the JSON-RPC progress
 * stream, drives a `TurnMonitor` for stall + hard-cap detection with
 * polling rollout-recovery, polls a cancel sentinel, writes per-turn
 * heartbeats for the status bar (via `turnHeartbeatWriter`), and
 * resolves with the assembled assistant text (`turnCompletion.ts`).
 * The `turn/start` body comes from `turnStartParams.ts`.
 *
 * Lazy rollout-path resolution is critical: Codex creates the rollout
 * file slightly after `thread/start` returns, so an eager call at
 * dispatch time returns null and would strand the status-bar glyph
 * at stage 2/5. The monitor re-asks for the path on every poll tick
 * until it gets one.
 *
 * Freshness-gated recovery (via `turnRecovery`) is the discipline
 * that keeps stale prior-turn text from being delivered as ours: the
 * gate captures the rollout's state at dispatch and every recovery
 * site checks `isFreshText` before settling.
 */

/** Adaptive raises every per-tool stall window to at least 2 minutes
 * so a legitimate pure-reasoning gap (model thinking without tool
 * calls or reasoning tokens bumping the rollout) does not trip the
 * 60-second default. */
const ADAPTIVE_STALL_FLOOR_MS = 120_000;
/** Adaptive's whole premise is "extend while making progress" - a
 * flat 5-minute hard cap from the monitor would interrupt the
 * underlying Codex turn before the MCP-side adaptive ceiling gives
 * up. Match the MCP ceiling so the two sides agree. */
const ADAPTIVE_HARD_CAP_MS = 30 * 60_000;
/** Deferred heartbeat-file unlink. Lets the bridge status bar
 * walker render every remaining stage's 3s min-hold (5 * 3s = 15s
 * worst case) after `settle()` writes the final stage=complete. */
const HEARTBEAT_CLEANUP_MS = 15_000;

interface TurnRunnerOptions {
  client: AppServerClient;
  threadId: string;
  env: Envelope;
  workspacePath: string;
  wsHash: string;
  logger: EpicHandshakeLogger;
  /** Wait mode at dispatch time. Widens the monitor's hard cap and
   * stall windows for Fire-and-Forget so long-chained scrapes do not
   * trip a false stall while Claude is no longer blocking. Locked
   * during in-flight turns (menu guard) so the value holds. */
  waitMode: WaitMode;
}

export function runTurnOnce(opts: TurnRunnerOptions): Promise<string> {
  const { client, threadId, env, workspacePath, wsHash, logger, waitMode } = opts;
  return new Promise((resolve, reject) => {
    const itemText: Map<string, string> = new Map();
    let cachedRolloutPath: string | null = findRolloutPath(threadId);
    const resolveRolloutPath = (): string | null => {
      if (cachedRolloutPath) return cachedRolloutPath;
      cachedRolloutPath = findRolloutPath(threadId);
      return cachedRolloutPath;
    };
    const freshness = createFreshnessGate(cachedRolloutPath, resolveRolloutPath);
    const hb = createHeartbeatWriter({
      envelopeId: env.id,
      workspacePath,
      wsHash,
      waitMode,
      logger,
    });
    // Tracks whether Codex acknowledged our turn (via `turn/started`,
    // first streaming delta, item lifecycle, or monitor progress).
    // Recovery paths gate on this so a turn/completed-shaped error
    // firing before any turn-lifecycle notification cannot reach for
    // stale rollout text.
    let ourTurnObserved = false;
    let settled = false;

    const cleanup = (): void => {
      deltaSub.dispose();
      completedSub.dispose();
      turnStartedSub.dispose();
      itemStartedSub.dispose();
      itemCompletedSub.dispose();
      disposeWatchers();
      monitor.stop();
      hb.scheduleCleanup(HEARTBEAT_CLEANUP_MS);
    };

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      // Final heartbeat at stage=complete so the bridge walker
      // resolves cleanly via fast-walk no matter how the turn ended.
      // Without this, cancel / error paths leave the walker at an
      // intermediate stage until LATCH_ORPHAN_GRACE_MS expires.
      hb.write("complete");
      cleanup();
      fn();
    };

    const sendInterrupt = (): void => {
      const interruptParams: TurnInterruptParams = { threadId };
      client.sendRequest("turn/interrupt", interruptParams).catch(() => {
        // intentionally swallowed - turn/interrupt is best-effort
      });
    };

    /** Every recovery site polls the rollout behind the same freshness
     * and turn-observed gates and delivers the same way. Only the
     * window, the log label, and the give-up path differ. */
    const recoverFromRollout = (
      window: RecoveryWindow,
      logLabel: string,
      onTimeout: () => void
    ): void => {
      recoverOrRejectViaRolloutPolling({
        window,
        getRolloutPath: resolveRolloutPath,
        isSettled: () => settled,
        isFreshText: freshness.isFreshText,
        requireTurnObserved: () => ourTurnObserved,
        onRecovered: (text) => {
          logger.info(`${logLabel} (len=${text.length})`);
          writeSuppressCodexToast(workspacePath);
          settle(() => resolve(text));
        },
        onTimeout,
      });
    };

    /** After the initial 30s rollout-recovery exhausts on a stall or
     * hard-cap, fall through to a longer background watch instead of
     * rejecting. Codex frequently lands a real reply after a perceived
     * stall (long task, mid-turn compact, slow flush) - the MCP tool's
     * caller-side timeout has already returned to the AI so no caller
     * wait is extended - this just lets the eventual reply land in the
     * inbox via the normal completion path. Only after the long window
     * exhausts do we declare a genuinely stuck turn and reject. */
    const startLateDeliveryWatch = (rejectReason: string): void => {
      if (settled) return;
      logger.info(
        `[monitor] initial recovery exhausted, opening ${LATE_DELIVERY_WINDOW.deadlineMs / 60_000}-min late-delivery watch`
      );
      recoverFromRollout(LATE_DELIVERY_WINDOW, "[monitor] late delivery recovered", () =>
        settle(() => reject(new Error(rejectReason)))
      );
    };

    const isFireAndForget = waitMode === "fire-and-forget";
    const isAdaptive = waitMode === "adaptive";

    const monitor = new TurnMonitor({
      resolveRolloutPath,
      logger,
      // Fire-and-Forget opts out of stall / hard-cap / phase-0
      // timers. The user explicitly asked for "reply lands when it
      // lands" so any ceiling defeats the mode.
      disableAllTimeouts: isFireAndForget,
      stallFloorMs: isAdaptive ? ADAPTIVE_STALL_FLOOR_MS : undefined,
      hardCapMs: isAdaptive ? ADAPTIVE_HARD_CAP_MS : undefined,
      onProgress: (stage, info) => {
        // Monitor progress is unambiguous proof the turn is
        // happening. Set the gate here so a transport hiccup that
        // swallows turn/started + item/* cannot block recovery when
        // the rollout poller IS seeing fresh progress.
        ourTurnObserved = true;
        hb.write(stage, info);
      },
      onStall: (reason) => {
        sendInterrupt();
        recoverFromRollout(
          INTERRUPT_RECOVERY_WINDOW,
          "[monitor] stall recovered via rollout fallback",
          () => startLateDeliveryWatch(reason)
        );
      },
      onHardCap: () => {
        sendInterrupt();
        recoverFromRollout(
          INTERRUPT_RECOVERY_WINDOW,
          "[monitor] hard cap recovered via rollout fallback",
          () => startLateDeliveryWatch("Codex exceeded max turn duration")
        );
      },
    });
    monitor.start();
    // Prime the heartbeat at stage=dispatched so the status bar
    // renders 1/5 immediately, before the first RPC progress signal
    // arrives several seconds in.
    hb.write("dispatched");

    const observeRpc = (signal: RpcProgressKind): void => {
      ourTurnObserved = true;
      monitor.observeRpcProgress(signal);
    };
    const turnStartedSub = client.onNotification("turn/started", () => observeRpc("turn-started"));
    // item/started + item/completed are unambiguous current-turn
    // proof: the app-server only emits them for the active turn.
    const itemStartedSub = client.onNotification("item/started", () => observeRpc("item-started"));
    const itemCompletedSub = client.onNotification("item/completed", () => observeRpc("item-completed"));

    let processingSignaled = false;
    const deltaSub = client.onNotification("item/agentMessage/delta", (params) => {
      observeRpc("delta");
      if (!processingSignaled) {
        // First streaming delta = Codex has accepted the turn and is
        // producing output. Flip the status bar from "sending" to the
        // "processing" animation. Deliberately NOT forcing stage 4 -
        // Codex emits agent_message in two phases (commentary + final
        // _answer) and the delta does not include phase - rely on the
        // rollout poller for stage 4 detection.
        writeProcessingFlag(workspacePath);
        processingSignaled = true;
      }
      accumulateDelta(itemText, params);
    });

    const completedSub = client.onNotification("turn/completed", (params) => {
      // Arrival of turn/completed is itself proof the turn happened,
      // even if every prior notification was lost. The recovery
      // branch gates on ourTurnObserved - set it here to unblock it.
      ourTurnObserved = true;
      monitor.forceStage("complete");
      const outcome = assembleTurnReply(params as TurnCompleted, itemText);
      if (outcome.kind === "reply") {
        // Drop the toast-suppress sentinel before the envelope-level
        // writeReply also writes it - consume-on-read makes the
        // double-write harmless.
        writeSuppressCodexToast(workspacePath);
        settle(() => resolve(outcome.text));
        return;
      }
      recoverFromRollout(
        COMPLETED_TURN_RECOVERY_WINDOW,
        `[recover] ${outcome.logLabel} but rollout has fresh reply`,
        () => settle(() => reject(outcome.failure))
      );
    });

    // Background watchers: liveness heartbeat, silent-completion
    // recovery, user-cancel sentinel. See `turnWatchers.ts` for the
    // per-watcher rationale - the disposer here clears all three
    // intervals on cleanup.
    const disposeWatchers = attachTurnWatchers({
      envelopeId: env.id,
      workspacePath,
      wsHash,
      logger,
      client,
      isFireAndForget,
      hb,
      freshness,
      resolveRolloutPath,
      isSettled: () => settled,
      isTurnObserved: () => ourTurnObserved,
      settle,
      sendInterrupt,
      resolve,
      reject,
    });

    // The reply arrives through turn/completed above. A rejection here
    // means our turn never started, so rollout-recovery would deliver
    // stale text, and the silent-completion watcher cannot rescue with
    // stale text either because it requires ourTurnObserved.
    client
      .sendRequest("turn/start", buildTurnStartParams(threadId, env, workspacePath, wsHash))
      .catch((err) => {
        settle(() => reject(err));
      });
  });
}
