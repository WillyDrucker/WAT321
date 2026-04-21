import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { parseLastAssistantText } from "../WAT321_CODEX_SESSION_TOKENS/parsers";
import { extractCurrentTurn, parseStageInfo } from "../shared/codex-rollout/phaseParser";
import { readTail } from "../shared/fs/fileReaders";
import type { AppServerClient } from "./appServerClient";
import { cancelFlagPath, turnHeartbeatPath } from "./constants";
import type { Envelope } from "./envelope";
import type { TurnInterruptParams, TurnStartParams } from "./protocol";
import { findRolloutPath } from "./threadPersistence";
import { TurnMonitor } from "./turnMonitor";
import { writeProcessingFlag, writeSuppressCodexToast } from "./turnFlags";
import type { EpicHandshakeLogger } from "./types";

/**
 * One-shot Codex turn execution. Subscribes to the JSON-RPC progress
 * stream, drives a `TurnMonitor` for stall + hard-cap detection with a
 * 3s grace window, polls a cancel sentinel, writes per-turn heartbeats
 * for the status bar, and resolves with the aggregated assistant text.
 *
 * Lazy rollout-path resolution is critical: Codex creates the rollout
 * file slightly after `thread/start` returns, so an eager call at
 * dispatch time often returns null and would strand the status-bar
 * glyph at stage 2/5. The monitor re-asks for the path on every poll
 * tick until it gets one.
 *
 * Stall recovery flow: send turn/interrupt, wait 3s for any final
 * task_complete + agent_message to flush, then read the rollout one
 * more time. If Codex secretly finished in the grace window, surface
 * the recovered text instead of an error.
 */

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
}

export function runTurnOnce(opts: TurnRunnerOptions): Promise<string> {
  const { client, threadId, env, workspacePath, wsHash, logger } = opts;
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const itemText: Map<string, string> = new Map();
    let cachedRolloutPath: string | null = findRolloutPath(threadId);
    const resolveRolloutPath = (): string | null => {
      if (cachedRolloutPath) return cachedRolloutPath;
      cachedRolloutPath = findRolloutPath(threadId);
      return cachedRolloutPath;
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
        stageEnteredAt[stage] = Date.now();
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
      const tmp = `${heartbeatFile}.tmp`;
      try {
        writeFileSync(tmp, body, "utf8");
        renameSync(tmp, heartbeatFile);
      } catch {
        // best-effort - heartbeat loss just means channel.mjs uses
        // its fallback timeout
      }
    };

    const cleanup = (): void => {
      deltaSub.dispose();
      completedSub.dispose();
      turnStartedSub.dispose();
      itemStartedSub.dispose();
      itemCompletedSub.dispose();
      clearInterval(cancelWatch);
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
      cleanup();
      fn();
    };

    const sendInterrupt = (): void => {
      const interruptParams: TurnInterruptParams = { threadId };
      client.sendRequest("turn/interrupt", interruptParams).catch(() => {
        // intentionally swallowed - turn/interrupt is best-effort
      });
    };

    const monitor = new TurnMonitor({
      resolveRolloutPath,
      logger,
      onProgress: (stage, info) => {
        writeHeartbeat(stage, info);
      },
      onStall: (reason) => {
        // Grace window: Codex often completes a turn within a couple
        // seconds of a stall. Send the interrupt first so any in-flight
        // tool stops, then wait 3s for any late flush, then read the
        // rollout one more time before giving up. Without the grace
        // window we report "Error state, no message" on turns where
        // Codex actually finished seconds after the stall fired.
        sendInterrupt();
        setTimeout(() => {
          if (settled) return;
          const recovered = tryRolloutRecovery(resolveRolloutPath());
          if (recovered) {
            logger.info(
              `[monitor] stall recovered via rollout fallback after 3s grace (len=${recovered.length})`
            );
            writeSuppressCodexToast(workspacePath);
            settle(() => resolve(recovered));
            return;
          }
          settle(() => reject(new Error(reason)));
        }, 3_000);
      },
      onHardCap: () => {
        sendInterrupt();
        setTimeout(() => {
          if (settled) return;
          const recovered = tryRolloutRecovery(resolveRolloutPath());
          if (recovered) {
            logger.info(
              `[monitor] hard cap recovered via rollout fallback after 3s grace (len=${recovered.length})`
            );
            writeSuppressCodexToast(workspacePath);
            settle(() => resolve(recovered));
            return;
          }
          settle(() => reject(new Error("Codex exceeded max turn duration")));
        }, 3_000);
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
      monitor.observeRpcProgress("turn-started");
    });
    const itemStartedSub = client.onNotification("item/started", () => {
      monitor.observeRpcProgress("item-started");
    });
    const itemCompletedSub = client.onNotification("item/completed", () => {
      monitor.observeRpcProgress("item-completed");
    });

    let processingSignaled = false;
    const deltaSub = client.onNotification("item/agentMessage/delta", (params) => {
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
        // Non-success terminal status (interrupted/failed). Do NOT
        // write the suppress-toast sentinel - if the bridge could not
        // deliver a real reply, the user should still see the Codex
        // toast for whatever Codex did produce so they know the turn
        // ended without a proper handoff.
        const errMsg = c.turn.error?.message ?? `turn ${c.turn.status}`;
        settle(() => reject(new Error(errMsg)));
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
        // produced no agentMessage items. No real reply to hand back
        // to Claude, so we reject with a "degraded thread" error.
        // Same rule as above - no suppress sentinel, the user should
        // see whatever Codex toast fires so they can tell something
        // is off.
        settle(() =>
          reject(
            new Error(
              "empty reply from Codex (thread may be in a degraded state; will rotate after threshold or pick \"Reset Codex Session\" from the menu)"
            )
          )
        );
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

    const turnStartParams: TurnStartParams = {
      threadId,
      input: [{ type: "text", text: env.body }],
      sandboxPolicy: { type: "readOnly" },
      approvalPolicy: "never",
    };
    client
      .sendRequest("turn/start", turnStartParams)
      .then(() => {
        // turn/start returned with the turn object; we still wait
        // for turn/completed notification (above)
      })
      .catch((err) => {
        settle(() => reject(err));
      });
  });
}

/** Read the rollout file and see if Codex finished writing this turn
 * even though the turn/completed notification never arrived. The case
 * that bit us in v1.2.1 testing: Codex wrote task_complete ~10s after
 * our timeout fired, but our subscription was already disposed.
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
