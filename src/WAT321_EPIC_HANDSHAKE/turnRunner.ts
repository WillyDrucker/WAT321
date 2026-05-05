import { existsSync, statSync, unlinkSync } from "node:fs";
import { parseLastAssistantText } from "../shared/codex-rollout/assistantTextParser";
import { extractCurrentTurn, parseStageInfo } from "../shared/codex-rollout/phaseParser";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { readTail } from "../shared/fs/fileReaders";
import type { AppServerClient } from "./appServerClient";
import {
  readCodexEffortOverride,
  readCodexModelOverride,
  readCodexSandboxOverride,
} from "./codexRuntimeOverrides";
import {
  cancelFlagPath,
  turnHeartbeatPath,
} from "./constants";
import type { Envelope } from "./envelope";
import type { TurnInterruptParams, TurnStartParams } from "./protocol";
import { findRolloutPath } from "./threadPersistence";
import { TurnMonitor } from "./turnMonitor";
import { writeProcessingFlag, writeSuppressCodexToast } from "./turnFlags";
import type { EpicHandshakeLogger } from "./types";
import type { WaitMode } from "./waitMode";

/**
 * One-shot Codex turn execution. Subscribes to the JSON-RPC progress
 * stream, drives a `TurnMonitor` for stall + hard-cap detection with a
 * polling rollout-recovery window, polls a cancel sentinel, writes
 * per-turn heartbeats for the status bar, and resolves with the
 * aggregated assistant text.
 *
 * Lazy rollout-path resolution is critical: Codex creates the rollout
 * file slightly after `thread/start` returns, so an eager call at
 * dispatch time often returns null and would strand the status-bar
 * glyph at stage 2/5. The monitor re-asks for the path on every poll
 * tick until it gets one.
 *
 * Stall / hard-cap recovery: send turn/interrupt, then poll the
 * rollout for up to ROLLOUT_RECOVERY_WINDOW_MS at ROLLOUT_RECOVERY_POLL_MS
 * cadence. Codex's flush latency after interrupt can substantially
 * exceed a single short grace window for long replies that were
 * mid-stream when we cut them off, so a polling loop catches the late
 * task_complete + agent_message that a single setTimeout would miss.
 * If a final assistant message ever lands during the window, surface
 * the recovered text instead of the synthetic error reply.
 */

/** Total wall-clock budget for rollout recovery after an interrupt.
 * Long bridge prompts (multi-thousand-token audits, deep code reads)
 * can need substantially longer than the original 3s flush window
 * before Codex commits its final assistant message, especially when
 * the interrupt arrives mid-stream. 30s is generous enough to catch
 * realistic post-interrupt flushes without keeping the bridge UI
 * frozen indefinitely on a turn that is genuinely stuck. */
const ROLLOUT_RECOVERY_WINDOW_MS = 30_000;
/** Tighter recovery window for `turn/completed` failure paths
 * (non-success status, empty items). The notification already arrived,
 * so any rollout-recovery either succeeds quickly or never will - long
 * polling adds latency without payoff. 5s catches the common "items
 * array missing but task_complete already on disk" race without
 * stretching the user's wait. */
const ROLLOUT_RECOVERY_FAST_WINDOW_MS = 5_000;
/** Poll cadence inside the recovery window. 1s balances reactivity
 * (recovery resolves within a second of Codex finishing its flush)
 * against I/O cost (one stat + tail read per poll, cheap). */
const ROLLOUT_RECOVERY_POLL_MS = 1_000;

interface AgentMessageDelta {
  itemId: string;
  delta: string;
}

interface TurnCompleted {
  turn: {
    id: string;
    status: "completed" | "interrupted" | "failed";
    items: Array<{ type: string; id: string; text?: string; status: string }>;
    error?: {
      message: string;
      codexErrorInfo?: string;
      additionalDetails?: string;
    } | null;
  };
}

export interface TurnRunnerOptions {
  client: AppServerClient;
  threadId: string;
  env: Envelope;
  workspacePath: string;
  wsHash: string;
  logger: EpicHandshakeLogger;
  /** Current wait mode at dispatch time. Widens the monitor's hard cap
   * and stall windows for Fire-and-Forget so long-chained scrapes (10+
   * web searches, multi-minute reasoning) do not trip a false stall or
   * the 5-minute hard cap while Claude is no longer blocking. Wait mode
   * is locked during in-flight turns (see statusBarMenus permissions
   * guard), so the value captured at dispatch holds for the full turn. */
  waitMode: WaitMode;
}

export function runTurnOnce(opts: TurnRunnerOptions): Promise<string> {
  const { client, threadId, env, workspacePath, wsHash, logger, waitMode } = opts;
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const itemText: Map<string, string> = new Map();
    let cachedRolloutPath: string | null = findRolloutPath(threadId);
    const resolveRolloutPath = (): string | null => {
      if (cachedRolloutPath) return cachedRolloutPath;
      cachedRolloutPath = findRolloutPath(threadId);
      return cachedRolloutPath;
    };
    // Seed assistant text captured BEFORE this turn dispatches. Used as
    // a baseline so rollout-recovery only resolves with text that is
    // demonstrably new (i.e. produced by THIS turn). Without this gate
    // a recovery path could return the prior turn's final answer when
    // our turn produced none of its own - exactly the stale-recovery
    // hazard for resumed threads.
    const seedAssistantText = (() => {
      const seedPath = cachedRolloutPath;
      if (!seedPath) return "";
      try {
        return tryRolloutRecovery(seedPath) ?? "";
      } catch {
        return "";
      }
    })();
    // Companion baseline: rollout file size at dispatch time. The size
    // gate is the secondary freshness proof for the rare case where
    // our turn legitimately produced an answer byte-identical to the
    // prior turn's answer (text equality alone would false-negative).
    // Any rollout growth past this offset is unambiguous evidence of
    // new content for this thread, since each thread owns its rollout
    // file and only the app-server writes to it.
    const seedRolloutSize = (() => {
      const seedPath = cachedRolloutPath;
      if (!seedPath) return 0;
      try {
        return statSync(seedPath).size;
      } catch {
        return 0;
      }
    })();
    // Tracks whether Codex acknowledged our turn (via `turn/started`
    // notification, first streaming delta, or any item lifecycle
    // event). Recovery paths gate on this so a turn/completed-shaped
    // error that fires before any of our turn-lifecycle notifications
    // can never reach for stale text in the rollout.
    let ourTurnObserved = false;
    /** Combined freshness gate for recovery callbacks. Passes when
     * EITHER the recovered text differs from the seed OR the rollout
     * has grown past the seed size (meaning new bytes for our thread,
     * even if those bytes happen to render the same final answer). */
    const isFreshRecovery = (text: string): boolean => {
      if (text !== seedAssistantText) return true;
      const path = resolveRolloutPath();
      if (!path) return false;
      try {
        return statSync(path).size > seedRolloutSize;
      } catch {
        return false;
      }
    };
    const heartbeatFile = turnHeartbeatPath(env.id);
    let settled = false;

    // Per-stage entry timestamps + turn-wide start so the status bar
    // tooltip can render a static 5-row block where each row shows
    // its stage's elapsed-or-completed duration. Accumulated across
    // every writeHeartbeat call; once a stage is stamped it is never
    // overwritten (monitor advance is monotonic, but a redundant
    // onProgress at the same stage shouldn't bump the timestamp).
    const stageEnteredAt: Partial<Record<string, number>> = {};
    const turnStartedAt = Date.now();

    const writeHeartbeat = (
      stage: string,
      info?: { activeTool?: { name: string } | null; toolCallCount: number; elapsedMs: number }
    ): void => {
      if (stageEnteredAt[stage] === undefined) {
        const enteredAt = Date.now();
        stageEnteredAt[stage] = enteredAt;
        // Log every first-time stage entry with elapsed-since-dispatch
        // so post-mortem timing analysis can answer "why did the
        // status bar pin on stage N for so long" without guessing.
        // Subsequent writeHeartbeat calls at the same stage (RPC
        // delta refreshes, rollout mtime bumps) are silent.
        const ms = enteredAt - turnStartedAt;
        logger.info(
          `[stage] envelope=${env.id} -> ${stage} at +${ms}ms (tools=${info?.toolCallCount ?? 0})`
        );
      }
      // Atomic tmp+rename so the status-bar reader never sees a
      // half-written JSON. A plain writeFileSync can be mid-flush
      // when readFileSync reads it, producing a parse error that the
      // reader swallows and returns null for - at which point the
      // widget falls back to the legacy arrow/info animation and the
      // user sees the adaptive stage glyph and legacy glyph alternate
      // on every tick.
      const body = JSON.stringify({
        envelopeId: env.id,
        workspacePath,
        workspaceHash: wsHash,
        stage,
        activeTool: info?.activeTool?.name ?? null,
        toolCallCount: info?.toolCallCount ?? 0,
        elapsedMs: info?.elapsedMs ?? 0,
        lastProgressAt: Date.now(),
        turnStartedAt,
        stageEnteredAt,
      });
      // best-effort - heartbeat loss just means channel.mjs uses its
      // fallback timeout
      writeFileAtomic(heartbeatFile, body);
    };

    const cleanup = (): void => {
      deltaSub.dispose();
      completedSub.dispose();
      turnStartedSub.dispose();
      itemStartedSub.dispose();
      itemCompletedSub.dispose();
      clearInterval(cancelWatch);
      clearInterval(silentCompletionWatch);
      monitor.stop();
      // Delete the heartbeat file on a 15s latch rather than right
      // away. The status bar's stage walker needs to see the file
      // at stage=complete (or any prior stage it's still walking
      // toward) for long enough to render each remaining stage for
      // its 3s minimum hold. Deleting immediately means the walker
      // reads null and stalls at whatever stage was displayed when
      // the turn ended - commonly stage 3 because the monitor
      // jumps 3 -> complete in the same poll window. 15s covers
      // the worst-case walk from dispatched -> complete (5 stages
      // * 3s = 15s) plus a small buffer.
      const t = setTimeout(() => {
        try {
          if (existsSync(heartbeatFile)) unlinkSync(heartbeatFile);
        } catch {
          // best-effort
        }
      }, 15_000);
      t.unref?.();
    };

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      // Final heartbeat write at stage=complete so the bridge widget
      // walker resolves cleanly via fast-walk no matter how the turn
      // ended (success, cancel, stall, hard-cap, error). Without this
      // the cancel / error paths leave the heartbeat at whatever
      // intermediate stage the parser last reached, and the walker
      // would sit on stage 1 / 2 / 3 until LATCH_ORPHAN_GRACE_MS
      // expired (~3s post heartbeat unlink). On success the monitor
      // already wrote stage=complete via forceStage, so this is a
      // redundant idempotent write. The delivered-flash check icon
      // gates on the bridge thread record's lastSuccessAt, which is
      // ONLY set on the success path - so cancel and error walks
      // still drop to idle without the spurious check.
      writeHeartbeat("complete");
      cleanup();
      fn();
    };

    const sendInterrupt = (): void => {
      const interruptParams: TurnInterruptParams = { threadId };
      client.sendRequest("turn/interrupt", interruptParams).catch(() => {
        // intentionally swallowed - turn/interrupt is best-effort
      });
    };

    const isFireAndForget = waitMode === "fire-and-forget";
    const isAdaptive = waitMode === "adaptive";
    // Adaptive raises every per-tool stall window to at least 2 minutes
    // so a legitimate pure-reasoning gap (model thinking without tool
    // calls or reasoning tokens bumping the rollout) does not trip the
    // 60-second default. Standard stays tight; Fire-and-Forget disables
    // timers entirely below.
    const ADAPTIVE_STALL_FLOOR_MS = 120_000;
    const monitor = new TurnMonitor({
      resolveRolloutPath,
      logger,
      // Fire-and-Forget opts out of stall / hard-cap / phase-0 timers.
      // The user explicitly asked for "reply lands when it lands" so
      // applying any ceiling defeats the mode. Cancel is available via
      // the status-bar action if the turn truly goes off the rails.
      disableAllTimeouts: isFireAndForget,
      stallFloorMs: isAdaptive ? ADAPTIVE_STALL_FLOOR_MS : undefined,
      onProgress: (stage, info) => {
        writeHeartbeat(stage, info);
      },
      onStall: (reason) => {
        sendInterrupt();
        recoverOrRejectViaRolloutPolling({
          deadlineMs: ROLLOUT_RECOVERY_WINDOW_MS,
          pollMs: ROLLOUT_RECOVERY_POLL_MS,
          getRolloutPath: resolveRolloutPath,
          isSettled: () => settled,
          isFreshText: isFreshRecovery,
          requireTurnObserved: () => ourTurnObserved,
          onRecovered: (text) => {
            logger.info(
              `[monitor] stall recovered via rollout fallback (len=${text.length})`
            );
            writeSuppressCodexToast(workspacePath);
            settle(() => resolve(text));
          },
          onTimeout: () => {
            settle(() => reject(new Error(reason)));
          },
        });
      },
      onHardCap: () => {
        sendInterrupt();
        recoverOrRejectViaRolloutPolling({
          deadlineMs: ROLLOUT_RECOVERY_WINDOW_MS,
          pollMs: ROLLOUT_RECOVERY_POLL_MS,
          getRolloutPath: resolveRolloutPath,
          isSettled: () => settled,
          isFreshText: isFreshRecovery,
          requireTurnObserved: () => ourTurnObserved,
          onRecovered: (text) => {
            logger.info(
              `[monitor] hard cap recovered via rollout fallback (len=${text.length})`
            );
            writeSuppressCodexToast(workspacePath);
            settle(() => resolve(text));
          },
          onTimeout: () => {
            settle(() => reject(new Error("Codex exceeded max turn duration")));
          },
        });
      },
    });
    monitor.start();
    // Prime the heartbeat at stage=dispatched so the status bar can
    // render 1/5 immediately. Without this the first heartbeat write
    // only happens on the first progress signal (turn/started,
    // rollout mtime bump), which arrives several seconds into the
    // turn - so stage 1 was silently skipped and the user saw the
    // widget jump straight to 2/5.
    writeHeartbeat("dispatched");

    const turnStartedSub = client.onNotification("turn/started", () => {
      ourTurnObserved = true;
      monitor.observeRpcProgress("turn-started");
    });
    // item/started + item/completed are also unambiguous current-turn
    // RPC proof: the app-server only emits them for the active turn.
    // Setting the gate here too means a turn whose `turn/started`
    // notification was lost (transport hiccup) but whose tool calls
    // streamed normally still allows recovery to resolve, instead of
    // blocking on a false-negative gate.
    const itemStartedSub = client.onNotification("item/started", () => {
      ourTurnObserved = true;
      monitor.observeRpcProgress("item-started");
    });
    const itemCompletedSub = client.onNotification("item/completed", () => {
      ourTurnObserved = true;
      monitor.observeRpcProgress("item-completed");
    });

    let processingSignaled = false;
    const deltaSub = client.onNotification("item/agentMessage/delta", (params) => {
      ourTurnObserved = true;
      if (!processingSignaled) {
        // First streaming delta = Codex has accepted the turn and is
        // actively producing output. Flip the status bar from the
        // "sending" arrow to the "processing" comment-discussion
        // animation so the user sees the real work phase.
        writeProcessingFlag(workspacePath);
        processingSignaled = true;
        // Deliberately NOT forcing stage=writing here. Codex emits
        // `agent_message` in two phases - `commentary` ("I'm checking
        // X first ...") and `final_answer`. The RPC delta notification
        // does not include the phase, so we cannot tell commentary
        // from final_answer at this layer. Forcing stage 4 on the
        // first delta was advancing the status bar to Writing during
        // commentary, while Codex then spent minutes doing real
        // research and reasoning - the user saw "Writing" stuck at
        // 4/5 during what was actually stage-3 working. Rely on the
        // rollout poller to detect stage 4 via `phase === "final_answer"`
        // (and the broader assistant-output shapes we now match).
      }
      monitor.observeRpcProgress("delta");
      const d = params as AgentMessageDelta;
      const prev = itemText.get(d.itemId) || "";
      itemText.set(d.itemId, prev + (d.delta || ""));
    });

    const completedSub = client.onNotification("turn/completed", (params) => {
      const c = params as TurnCompleted;
      monitor.forceStage("complete");

      if (c.turn.status !== "completed") {
        // Non-success terminal status (interrupted/failed). Codex may
        // still have completed work on disk before the failure
        // surfaced - try a tight rollout recovery before declaring
        // failure so a legitimate reply is never lost to a transient
        // RPC-layer hiccup. No suppress-toast sentinel on the failure
        // path: if rollout recovery also misses, the user should still
        // see the Codex toast for whatever Codex did produce.
        const errMsg = c.turn.error?.message ?? `turn ${c.turn.status}`;
        recoverOrRejectViaRolloutPolling({
          deadlineMs: ROLLOUT_RECOVERY_FAST_WINDOW_MS,
          pollMs: ROLLOUT_RECOVERY_POLL_MS,
          getRolloutPath: resolveRolloutPath,
          isSettled: () => settled,
          isFreshText: isFreshRecovery,
          requireTurnObserved: () => ourTurnObserved,
          onRecovered: (text) => {
            logger.info(
              `[recover] turn/completed status=${c.turn.status} but rollout has fresh reply (len=${text.length}); delivering recovered text`
            );
            writeSuppressCodexToast(workspacePath);
            settle(() => resolve(text));
          },
          onTimeout: () => {
            settle(() => reject(new Error(errMsg)));
          },
        });
        return;
      }

      // Prefer final item text over aggregated deltas
      for (const item of c.turn.items) {
        if (item.type === "agentMessage" && item.text) {
          chunks.push(item.text);
        }
      }
      if (chunks.length === 0) {
        // Fall back to delta aggregation
        for (const text of itemText.values()) chunks.push(text);
      }

      const combined = chunks.join("\n").trim();
      if (combined.length === 0) {
        // Empty completed turn: Codex's TCP round ended cleanly but
        // produced no agentMessage items in the notification AND no
        // deltas streamed. Try the rollout once - the
        // task_complete + agent_message may have landed on disk a
        // beat before the RPC notification reached us with stale
        // items. If recovery misses, surface the degraded-thread
        // error so the user sees something is off.
        recoverOrRejectViaRolloutPolling({
          deadlineMs: ROLLOUT_RECOVERY_FAST_WINDOW_MS,
          pollMs: ROLLOUT_RECOVERY_POLL_MS,
          getRolloutPath: resolveRolloutPath,
          isSettled: () => settled,
          isFreshText: isFreshRecovery,
          requireTurnObserved: () => ourTurnObserved,
          onRecovered: (text) => {
            logger.info(
              `[recover] turn/completed empty items but rollout has fresh reply (len=${text.length}); delivering recovered text`
            );
            writeSuppressCodexToast(workspacePath);
            settle(() => resolve(text));
          },
          onTimeout: () => {
            settle(() =>
              reject(
                new Error(
                  "empty reply from Codex (thread may be in a degraded state; will rotate after threshold or pick \"Reset Codex Session\" from the menu)"
                )
              )
            );
          },
        });
        return;
      }
      // Success path: real reply on its way to Claude. Drop the
      // sentinel now - before the envelope-level writeReply in
      // processEnvelope also writes it - so the session-token
      // service's PathWatcher, which can fire responseComplete within
      // the same millisecond as turn/completed, consumes our flag on
      // its very next notifier pass. Consume-on-read makes the
      // double-write from processEnvelope harmless.
      writeSuppressCodexToast(workspacePath);
      settle(() => resolve(combined));
    });

    // Background silent-completion watcher. Closes the gap when
    // Codex finishes the turn on disk but the JSON-RPC notification
    // chain drops the `turn/completed` event - documented in the
    // session-severance log as the most damaging failure class. Polls
    // the rollout every SILENT_COMPLETION_POLL_MS while the turn is
    // in flight; resolves the promise as soon as the rollout shows
    // the current turn complete with fresh assistant text. Strictly
    // gated on ourTurnObserved + fresh-vs-seed so a stale prior turn
    // can never be returned. Without this watcher the bridge has to
    // wait for the stall window to expire (60s+ default) before any
    // recovery attempt fires, which is exactly the multi-minute UX
    // delay we're closing.
    const SILENT_COMPLETION_POLL_MS = 2_000;
    const silentCompletionWatch = setInterval(() => {
      if (settled) return;
      if (!ourTurnObserved) return;
      const recovered = tryRolloutRecovery(resolveRolloutPath());
      if (recovered === null) return;
      if (!isFreshRecovery(recovered)) return;
      logger.info(
        `[recover] silent-completion watcher: rollout shows current turn complete with fresh text (len=${recovered.length}); delivering before stall window`
      );
      writeSuppressCodexToast(workspacePath);
      settle(() => resolve(recovered));
    }, SILENT_COMPLETION_POLL_MS);
    silentCompletionWatch.unref?.();

    // User-cancel sentinel. Status bar's "Cancel in-flight prompt"
    // action writes the workspace cancel flag; we poll every 500ms,
    // send turn/interrupt and reject with a distinct message so
    // Claude's reply is unambiguous ("cancelled by user").
    const cancelPath = cancelFlagPath(wsHash);
    const cancelWatch = setInterval(() => {
      if (!existsSync(cancelPath)) return;
      try {
        unlinkSync(cancelPath);
      } catch {
        // best-effort
      }
      sendInterrupt();
      settle(() => reject(new Error("cancelled by user")));
    }, 500);

    // Read all three runtime overrides on every turn so the Codex
    // Defaults picker (and settings) take effect on the next prompt
    // without a thread reset. Casing for sandboxPolicy here is
    // camelCase - different from the kebab-case string at thread/start
    // (see TurnSandboxPolicy in protocol.ts). Model + effort accept
    // null when no override is set; Codex falls back to the thread /
    // config default in that case. Approval policy stays pinned to
    // `never`; the bridge has no UI to relay Codex's approval prompts
    // back mid-turn.
    const sandboxPolicy =
      readCodexSandboxOverride(wsHash) === "full-access"
        ? ({ type: "dangerFullAccess" } as const)
        : ({ type: "readOnly" } as const);
    const turnStartParams: TurnStartParams = {
      threadId,
      input: [{ type: "text", text: env.body }],
      sandboxPolicy,
      approvalPolicy: "never",
      model: readCodexModelOverride(wsHash),
      effort: readCodexEffortOverride(wsHash),
    };
    client
      .sendRequest("turn/start", turnStartParams)
      .then(() => {
        // turn/start returned with the turn object; we still wait
        // for turn/completed notification (above)
      })
      .catch((err) => {
        // turn/start rejected at the request layer - our turn never
        // started. The rollout's "current turn" slice belongs to a
        // prior turn (or doesn't exist), so rollout-recovery here
        // would deliver stale text. Surface the error directly. The
        // background rollout-complete watcher (below) only resolves
        // when ourTurnObserved is true, so it cannot rescue the user
        // with stale text either.
        settle(() => reject(err));
      });
  });
}

/** Read the rollout file and see if Codex finished writing this turn
 * even though the turn/completed notification never arrived. Codex can
 * write task_complete to disk seconds after our timeout fires when our
 * subscription has already been disposed, so the rollout is the source
 * of truth for "did the turn actually finish" once the notification
 * path has given up.
 *
 * Turn-scoping is load-bearing here. `parseStageInfo` and
 * `parseLastAssistantText` are both called on the current-turn slice
 * only. Without that, a failed current turn would happily "recover"
 * with stale assistant text from a prior completed turn in the same
 * rollout - a silent wrong-answer bug. */
function tryRolloutRecovery(rolloutPath: string | null): string | null {
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
  deadlineMs: number;
  pollMs: number;
  getRolloutPath: () => string | null;
  isSettled: () => boolean;
  /** Optional gate: only resolve with recovered text when it differs
   * from a baseline captured before this turn dispatched. Without
   * this gate, a thread that resumed an earlier completed turn would
   * happily "recover" the prior turn's final answer when our turn
   * never produced one. Treat undefined as "always fresh" so existing
   * stall / hard-cap callers keep their pre-gate behavior unless they
   * opt in. */
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
 * succeeds or the deadline elapses. Replaces the previous single-shot
 * setTimeout grace window: a long Codex reply that was mid-stream when
 * the interrupt fired can take longer than a fixed window to flush, and
 * a single short wait would miss it - producing a synthetic
 * "max turn duration" error reply when Codex actually had a real reply
 * one second later. The polling loop catches that late commit. */
function recoverOrRejectViaRolloutPolling(opts: RecoveryPollOptions): void {
  const startedAt = Date.now();
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
    if (Date.now() - startedAt >= opts.deadlineMs) {
      opts.onTimeout();
      return;
    }
    setTimeout(tick, opts.pollMs);
  };
  setTimeout(tick, opts.pollMs);
}
