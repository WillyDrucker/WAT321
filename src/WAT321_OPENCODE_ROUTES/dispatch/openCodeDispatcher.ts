import type * as vscode from "vscode";
import type { BackendDispatcher, DispatchRequest, DispatchResult } from "../../engine/dispatcher/dispatcherTypes";
import { deleteHeartbeat, writeHeartbeat } from "../../engine/heartbeat/heartbeatWriter";
import { workspaceHash } from "../../engine/workspaceHash";
import {
  clearOpenCodeWidgetHeartbeat,
  writeOpenCodeLastUsed,
  writeOpenCodeWidgetHeartbeat,
} from "./openCodeDispatchHeartbeat";
import { readAliases, SESSION_ALIASES_PATH } from "../../shared/bridge/sessionAliases";
import {
  findInstance,
  readActiveAlias,
  readRoutesConfig,
} from "./openCodeDispatchConfig";
import {
  runSessionAttached,
  runZenOneShot,
} from "./openCodeDispatchPaths";
import type { BridgeStage } from "../../engine/bridgeTypes";

/**
 * Extension-side dispatcher for OpenCode (and OpenCode-aliased models
 * like Big Pickle) plus Local LLM. Implements the engine's
 * `BackendDispatcher` contract so the engine's `OutboundWatcher`
 * drives it the same way it drives the Codex dispatcher.
 *
 * Lifecycle parity with Codex:
 *   - Outbound envelope arrives in `<bridgeStateDir>/dispatch/<target>/`.
 *   - `OutboundWatcher` picks it up and invokes `run()`.
 *   - `run()` resolves the target instance + session alias, wires
 *     the bridge stage heartbeat ticker, and delegates the actual
 *     HTTP to `runZenOneShot` (anonymous) or `runSessionAttached`
 *     (session-attached) in `openCodeDispatchPaths.ts`.
 *   - During the call, heartbeats land in EH_ROOT so the bridge
 *     stage coordinator can animate.
 *   - On graceful shutdown, the engine aborts the request's signal,
 *     this dispatcher propagates to its AbortController, and the
 *     watcher writes a synthetic "cancelled by shutdown" inbound.
 *
 * The HTTP logic ports the relevant slices of
 * `WAT321_MCP_SERVER/bin/opencode/dispatch.mjs` because the MCP
 * runtime is `.mjs` and cannot be imported here. Kept narrow:
 * only the fire-and-forget paths are ported. Sync dispatch
 * continues to run inline in the MCP runtime.
 */

const HEARTBEAT_INTERVAL_MS = 5_000;
const WIDGET_HEARTBEAT_TIMEOUT_MS = 10 * 60_000;

type HttpHandle = {
  controller: AbortController;
  /** Heartbeat ticker so the bridge stage coordinator can animate
   * during long calls. */
  heartbeatTimer: ReturnType<typeof setInterval>;
};

class OpenCodeDispatcher implements BackendDispatcher {
  readonly target: "opencode" | "local";
  private accepting = true;
  private inFlight = new Set<HttpHandle>();

  constructor(target: "opencode" | "local") {
    this.target = target;
  }

  isAccepting(): boolean {
    return this.accepting;
  }

  async run(request: DispatchRequest): Promise<DispatchResult> {
    const env = request.envelope;
    const prompt = env.body;
    const sessionAlias = readActiveAlias(this.target, env);
    const cfg = readRoutesConfig();

    // Resolve the instance once so the engine heartbeat + widget
    // heartbeat + post-dispatch last-used sidecar all see consistent
    // metadata. Session-attached: alias map's instanceId wins. One-
    // shot: kind-matched active instance.
    const aliasMap = readAliases(SESSION_ALIASES_PATH);
    const aliasEntry =
      sessionAlias !== null
        ? aliasMap[this.target]?.[sessionAlias]
        : undefined;
    const targetKind = this.target === "local" ? "local" : "remote";
    const resolvedInst = aliasEntry?.instanceId
      ? findInstance(cfg, aliasEntry.instanceId, null)
      : findInstance(cfg, null, targetKind);
    const widgetAlias =
      resolvedInst?.alias ||
      env.alias ||
      (this.target === "local" ? "Local LLM" : "OpenCode");
    const widgetModel = resolvedInst?.model || "";
    const widgetDataRetention = resolvedInst?.dataRetention ?? null;
    const widgetInstanceId = resolvedInst?.id ?? null;

    // Heartbeat ticker writes the canonical 5-stage progression so
    // the bridge stage coordinator advances past `working` (idx 2)
    // on every non-Codex dispatch. Without this walk the coordinator
    // latches at stage 3 for the full dispatch and never plays the
    // stages 4/5 return ceremony - the user sees "Big Pickle stops
    // at the working square and the reply just appears in the inbox."
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const workspacePath = request.workspacePath ?? env.workspacePath ?? "";
    const wsHash = workspacePath ? workspaceHash(workspacePath) : "default";
    let currentStage: BridgeStage = "dispatched";
    const beat = (): void => {
      try {
        writeHeartbeat({
          dispatchId: env.id,
          target: env.target,
          workspacePath,
          workspaceHash: wsHash,
          stage: currentStage,
          activeTool: null,
          toolCallCount: 0,
          elapsedMs: Date.now() - startedAt,
          lastProgressAt: Date.now(),
          turnStartedAt: startedAt,
          waitMode: env.waitMode,
        });
      } catch {
        // best-effort
      }
      writeOpenCodeWidgetHeartbeat({
        startedAt: startedAtIso,
        requestId: env.id,
        alias: widgetAlias,
        instanceId: widgetInstanceId,
        dataRetention: widgetDataRetention,
        model: widgetModel,
        // 10-min cap mirrors the dispatch path timeouts so the
        // widget's "stale" gate matches the dispatcher ceiling.
        timeoutMs: WIDGET_HEARTBEAT_TIMEOUT_MS,
      });
    };
    const setStage = (s: BridgeStage): void => {
      currentStage = s;
      beat();
    };
    beat();
    const heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);

    const controller = new AbortController();
    request.signal.addEventListener("abort", () => controller.abort());
    const handle: HttpHandle = { controller, heartbeatTimer };
    this.inFlight.add(handle);

    try {
      const result =
        sessionAlias !== null
          ? await runSessionAttached({
              target: this.target,
              prompt,
              cfg,
              signal: controller.signal,
              setStage,
              sessionAlias,
            })
          : await runZenOneShot({
              target: this.target,
              prompt,
              cfg,
              signal: controller.signal,
              setStage,
            });
      // Persist the last-dispatched instance on success so the widget
      // flips to the alias we just ran even when the user's
      // `activeInstanceId` points elsewhere. Errors skip the write -
      // showing "Big Pickle" after a failed call would mislead.
      if (!result.error && widgetInstanceId) {
        writeOpenCodeLastUsed({
          instanceId: widgetInstanceId,
          alias: widgetAlias,
          dataRetention: widgetDataRetention,
          model: widgetModel,
        });
        // Final `complete` push. Without it the walker would orphan-
        // grace-drop the latch at `writing` (idx 3) after 3s and
        // never reach `complete` (idx 4), skipping the stages 4/5 +
        // left-arrow return ceremony.
        setStage("complete");
      }
      return result;
    } catch (err) {
      if (controller.signal.aborted) {
        return {
          body:
            "[Dispatch aborted.]\n\nThe in-flight call to " +
            (env.alias || this.target) +
            " was cancelled (likely VS Code shutdown). Reissue the prompt if you still need the answer.",
          error: true,
        };
      }
      return {
        body: `Dispatch error: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      };
    } finally {
      clearInterval(heartbeatTimer);
      this.inFlight.delete(handle);
      deleteHeartbeat(env.id);
      clearOpenCodeWidgetHeartbeat();
    }
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    for (const h of this.inFlight) {
      try {
        h.controller.abort();
      } catch {
        // best-effort
      }
      clearInterval(h.heartbeatTimer);
    }
    this.inFlight.clear();
  }
}

/** Factory the activation code calls to build the dispatcher for a
 * given target. Symmetric with the Codex dispatcher factory in
 * `WAT321_EPIC_HANDSHAKE/index.ts` so future per-target dispatchers
 * follow the same shape. No logger parameter today - the dispatcher
 * surfaces errors via the inbound envelope's `error: true` flag,
 * which is what the user sees. */
export function createOpenCodeDispatcher(
  target: "opencode" | "local"
): vscode.Disposable & BackendDispatcher {
  const dispatcher = new OpenCodeDispatcher(target);
  return Object.assign(dispatcher, {
    dispose(): void {
      void dispatcher.shutdown();
    },
  });
}
