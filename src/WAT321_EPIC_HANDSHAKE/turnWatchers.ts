import { existsSync, unlinkSync } from "node:fs";
import type { AppServerClient } from "./appServerClient";
import { cancelFlagPath } from "./constants";
import { tryRolloutRecovery } from "./rolloutRecovery";
import { writeSuppressCodexToast } from "./turnFlags";
import type { FreshnessGate } from "./turnRecovery";
import type { HeartbeatWriter } from "./turnHeartbeatWriter";
import type { EpicHandshakeLogger } from "./types";

/**
 * Three background watchers that drive `runTurnOnce` to settle on
 * polled conditions the JSON-RPC stream cannot give us:
 *
 *  - liveness   - re-emit the heartbeat at the current stage while
 *                 Codex is alive but quiet (long tool calls can run
 *                 minutes between RPC events) - reject when an FF
 *                 turn observes the app-server child die.
 *  - silent     - rollout shows the turn complete with fresh text
 *    completion   before the `turn/completed` notification arrives.
 *                 Strictly fresh-gated to never deliver prior-turn
 *                 text.
 *  - cancel     - user-cancel sentinel flag fired from the status
 *                 bar's "Cancel in-flight prompt" action.
 *
 * Returned as a single `dispose()` so the runner's cleanup is one
 * call per concern.
 */

const LIVENESS_HEARTBEAT_MS = 60_000;
const SILENT_COMPLETION_POLL_MS = 2_000;
const CANCEL_POLL_MS = 500;

export interface TurnWatcherDeps {
  envelopeId: string;
  workspacePath: string;
  wsHash: string;
  logger: EpicHandshakeLogger;
  client: AppServerClient;
  isFireAndForget: boolean;
  hb: HeartbeatWriter;
  freshness: FreshnessGate;
  resolveRolloutPath: () => string | null;
  isSettled: () => boolean;
  isTurnObserved: () => boolean;
  settle: (fn: () => void) => void;
  sendInterrupt: () => void;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

/** Start the three watchers and return a disposer that clears all
 * three intervals at once. Caller (the runner's `cleanup()`) invokes
 * the disposer when the promise settles. */
export function attachTurnWatchers(deps: TurnWatcherDeps): () => void {
  const liveness = startLivenessHeartbeat(deps);
  const silent = startSilentCompletionWatcher(deps);
  const cancel = startCancelWatcher(deps);
  return () => {
    clearInterval(liveness);
    clearInterval(silent);
    clearInterval(cancel);
  };
}

function startLivenessHeartbeat(deps: TurnWatcherDeps): NodeJS.Timeout {
  const t = setInterval(() => {
    if (deps.isSettled()) return;
    if (!deps.client.isAlive) {
      if (deps.isFireAndForget) {
        deps.logger.warn(
          `[ff-abort] app-server died mid-turn (envelope=${deps.envelopeId}); rejecting so claim + flags release`
        );
        deps.sendInterrupt();
        deps.settle(() =>
          deps.reject(
            new Error(
              "Codex app-server died mid-turn during fire-and-forget dispatch"
            )
          )
        );
      }
      return;
    }
    deps.hb.write(deps.hb.lastStage());
  }, LIVENESS_HEARTBEAT_MS);
  t.unref?.();
  return t;
}

function startSilentCompletionWatcher(deps: TurnWatcherDeps): NodeJS.Timeout {
  const t = setInterval(() => {
    if (deps.isSettled()) return;
    if (!deps.isTurnObserved()) return;
    const recovered = tryRolloutRecovery(deps.resolveRolloutPath());
    if (recovered === null) return;
    if (!deps.freshness.isFreshText(recovered)) return;
    deps.logger.info(
      `[recover] silent-completion watcher: rollout shows current turn complete with fresh text (len=${recovered.length}); delivering before stall window`
    );
    writeSuppressCodexToast(deps.workspacePath);
    deps.settle(() => deps.resolve(recovered));
  }, SILENT_COMPLETION_POLL_MS);
  t.unref?.();
  return t;
}

function startCancelWatcher(deps: TurnWatcherDeps): NodeJS.Timeout {
  const cancelPath = cancelFlagPath(deps.wsHash);
  return setInterval(() => {
    if (!existsSync(cancelPath)) return;
    try {
      unlinkSync(cancelPath);
    } catch {
      // best-effort
    }
    deps.sendInterrupt();
    deps.settle(() => deps.reject(new Error("cancelled by user")));
  }, CANCEL_POLL_MS);
}
