import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type * as vscode from "vscode";
import type {
  BackendDispatcher,
  DispatchRequest,
  DispatchResult,
} from "../engine/dispatcher";
import { deleteHeartbeat, writeHeartbeat } from "../engine/heartbeat";
import type { HeartbeatStage } from "../engine/heartbeat";
import { WAT321_RESEARCH_AGENT } from "../shared/providers/opencode/configBuilder";
import { bridgeStateDir } from "../shared/wat321Paths";
import { workspaceHash } from "../shared/workspaceHash";
import { CONFIG_PATH as OPENCODE_ROUTES_CONFIG_PATH } from "./constants";
import {
  clearOpenCodeWidgetHeartbeat,
  writeOpenCodeLastUsed,
  writeOpenCodeWidgetHeartbeat,
} from "./openCodeDispatchHeartbeat";

/**
 * Extension-side dispatcher for OpenCode (and OpenCode-aliased models
 * like Big Pickle) plus Local LLM. Implements the engine's
 * `BackendDispatcher` contract so the engine's `OutboundWatcher` can
 * drive it the same way it drives the Codex dispatcher.
 *
 * Lifecycle parity with Codex:
 *   - Outbound envelope arrives in `<bridgeStateDir>/dispatch/<target>/`.
 *   - `OutboundWatcher` picks it up and invokes `run()`.
 *   - `run()` makes the HTTP/SSE call to opencode serve (session-
 *     attached) or to opencode.ai/zen (anonymous one-shot).
 *   - During the call, heartbeats land in EH_ROOT so the bridge stage
 *     coordinator can animate (best-effort - we pin to `working`
 *     because OpenCode has no per-stage notion).
 *   - On resolve, `OutboundWatcher` writes the inbound envelope.
 *   - On graceful shutdown, the engine aborts the request's signal,
 *     this dispatcher propagates to its AbortController, and the
 *     watcher writes a synthetic "cancelled by shutdown" inbound.
 *
 * The HTTP logic is a small TypeScript port of the relevant slices of
 * `WAT321_MCP_SERVER/bin/opencode/dispatch.mjs` because the MCP
 * runtime is `.mjs` and cannot be imported here. Kept narrow on
 * purpose: only the paths that matter for fire-and-forget dispatch
 * are ported. Sync dispatch continues to run inline in the MCP
 * runtime, where it is already correct and fast.
 */

const ANON_BASE_URL = "https://opencode.ai/zen/v1";
const HEARTBEAT_INTERVAL_MS = 5_000;

/** Subset of the OpenCode Routes config the extension's `config.ts`
 * writes to `<openCodeRoutesStateDir>/config.json`. Only the fields
 * this dispatcher reads are typed - the rest of the file (API keys,
 * data retention, etc.) is irrelevant here. */
interface OpenCodeRoutesConfigSlice {
  /** Live URL of the managed `opencode serve` subprocess. Empty when
   * OpenCode is disabled or the manager has not spawned one yet -
   * mirrors what the MCP-side `opencode/config.mjs:readServeUrl()`
   * reads. */
  openCodeServerUrl?: string;
  instances?: Array<{
    id: string;
    alias?: string;
    kind?: "remote" | "local";
    model?: string;
    harnessProviderID?: "llama.cpp" | "zen";
    dataRetention?: "local" | "retained";
  }>;
  activeInstanceId?: string | null;
}

interface AliasMap {
  opencode?: Record<string, { sessionId: string; instanceId?: string | null }>;
  local?: Record<string, { sessionId: string; instanceId?: string | null }>;
  activeAliases?: { opencode?: string | null; local?: string | null };
}

/** Read the OpenCode Routes config the extension's `config.ts` writes
 * at `<openCodeRoutesStateDir()>/config.json`. This is the same file
 * the MCP-side `opencode/config.mjs` reads, so the extension-side
 * dispatcher and the MCP-side sync handler stay in sync on the live
 * opencode serve URL + instance catalog.
 *
 * IMPORTANT: NOT to be confused with `<bridgeStateDir()>/config.json`
 * which is a different file (the unified MCP server's enabled-targets
 * snapshot). An earlier draft of this dispatcher read the wrong file
 * and got "opencode serve is not running" errors even when adaptive
 * dispatch (which uses the correct file via the MCP runtime) worked
 * fine in the same session. */
function readRoutesConfig(): OpenCodeRoutesConfigSlice | null {
  try {
    if (!existsSync(OPENCODE_ROUTES_CONFIG_PATH)) return null;
    return JSON.parse(
      readFileSync(OPENCODE_ROUTES_CONFIG_PATH, "utf8")
    ) as OpenCodeRoutesConfigSlice;
  } catch {
    return null;
  }
}

/** Path the MCP runtime's `opencode/aliases.mjs` writes
 * (`<bridgeStateDir>()/session-aliases.json`). Reading anywhere else
 * means the dispatcher won't see sessions the user just created via
 * `wat321_session` - same class of mistake as the config-path bug.
 * Kept as a fresh `join()` rather than a regex on the config path
 * because the two files live in different per-client subtrees
 * (`bridge/` vs `model-bridge/`). */
function aliasMapPath(): string {
  return join(bridgeStateDir(), "session-aliases.json");
}

function readAliasMap(): AliasMap {
  const path = aliasMapPath();
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as AliasMap;
  } catch {
    return {};
  }
}

type RoutesInstance = NonNullable<OpenCodeRoutesConfigSlice["instances"]>[number];

/** Resolve a catalog instance. Explicit id wins; falling back to the
 * kind-filtered active instance; final fallback to any kind-matching
 * entry. Mirrors the MCP-side `opencode/config.mjs:findInstance`
 * fallback chain so dispatchers behave identically across processes. */
function findInstance(
  cfg: OpenCodeRoutesConfigSlice | null,
  instanceId: string | null,
  kind: "remote" | "local" | null
): RoutesInstance | null {
  const instances = cfg?.instances ?? [];
  if (instances.length === 0) return null;
  if (instanceId) {
    const found = instances.find((i) => i.id === instanceId);
    if (found) return found;
  }
  const activeId = cfg?.activeInstanceId ?? null;
  if (activeId) {
    const active = instances.find((i) => i.id === activeId);
    if (active && (kind === null || active.kind === kind)) return active;
  }
  return instances.find((i) => kind === null || i.kind === kind) ?? null;
}

type HttpHandle = {
  controller: AbortController;
  /** Heartbeat ticker so the bridge stage coordinator can animate
   * during long calls. */
  heartbeatTimer: ReturnType<typeof setInterval>;
};

export class OpenCodeDispatcher implements BackendDispatcher {
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

    // Resolve the instance once so the engine heartbeat + the legacy
    // OpenCode widget heartbeat + the post-dispatch last-used sidecar
    // all see consistent metadata. For session-attached dispatches the
    // alias map's instanceId takes precedence; for one-shots we fall
    // back to the kind-matched active instance. Both branches reduce
    // to the same `findInstance` call we use deeper in the runner.
    const aliasMap = readAliasMap();
    const aliasEntry =
      sessionAlias !== null ? aliasMap[this.target]?.[sessionAlias] : undefined;
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

    // Heartbeat ticker writes the canonical 5-stage progression so the
    // bridge stage coordinator advances past `working` (idx 2) on every
    // non-Codex dispatch. Stage transitions:
    //   - dispatched: initial heartbeat before fetch begins
    //   - received: fetch() resolved with a response status (server
    //     accepted the prompt; model is queued)
    //   - working: response body is streaming back from the model
    //   - writing: body fully parsed; result text is in hand
    //   - complete: about to return to the OutboundWatcher
    // Without this walk the coordinator latches at stage 3 for the full
    // dispatch and never plays the stages 4/5 return ceremony, which is
    // what the user sees as "Big Pickle stops at the working square and
    // the reply just appears in the inbox".
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const workspacePath = request.workspacePath ?? env.workspacePath ?? "";
    const wsHash = workspacePath ? workspaceHash(workspacePath) : "default";
    let currentStage: HeartbeatStage = "dispatched";
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
        // 10-min cap mirrors the runSessionAttached / runOneShot
        // timeouts so the widget's "stale" gate matches the actual
        // dispatcher ceiling instead of the legacy 2-min default.
        timeoutMs: 10 * 60_000,
      });
    };
    const setStage = (s: HeartbeatStage): void => {
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
          ? await this.runSessionAttached(
              env.id,
              sessionAlias,
              prompt,
              cfg,
              controller.signal,
              setStage
            )
          : await this.runOneShot(prompt, cfg, controller.signal, setStage);
      // Persist the last-dispatched instance on success so the widget
      // flips to the alias we just ran (e.g. Big Pickle) even when the
      // user's `activeInstanceId` preference points somewhere else.
      // Errors deliberately skip the write - showing "Big Pickle" after
      // a failed call would be misleading.
      if (!result.error && widgetInstanceId) {
        writeOpenCodeLastUsed({
          instanceId: widgetInstanceId,
          alias: widgetAlias,
          dataRetention: widgetDataRetention,
          model: widgetModel,
        });
        // Final "complete" stage push. Without this, the coordinator's
        // walker would orphan-grace-drop the latch at `writing` (idx 3)
        // after 3 seconds and never reach `complete` (idx 4), skipping
        // the stages 4/5 + left-arrow return ceremony. The walker reads
        // this final write, sets `lastTargetStage = complete`, and
        // fast-walks intermediate stages before holding stage 5 for
        // the full COMPLETE_WALK_HOLD_MS so the return animation has
        // time to play.
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

  /** Anonymous one-shot via opencode.ai/zen. Used when no session
   * alias is resolved - common path for "ask Big Pickle" without
   * the user having created a session. Model selection follows the
   * resolved instance's `model` field; falls back to `big-pickle`. */
  private async runOneShot(
    prompt: string,
    cfg: OpenCodeRoutesConfigSlice | null,
    signal: AbortSignal,
    setStage: (s: HeartbeatStage) => void
  ): Promise<DispatchResult> {
    const kind = this.target === "local" ? "local" : "remote";
    if (this.target === "local") {
      return {
        body: "Local LLM fire-and-forget requires a session. Create one via wat321_session({target:'local', action:'create'}), then retry.",
        error: true,
      };
    }
    const inst = findInstance(cfg, null, kind);
    const model = inst?.model || "big-pickle";
    const alias = inst?.alias || "Big Pickle";

    // Same 10-minute hard cap as runSessionAttached; identical
    // rationale (long enough for slow cold models, short enough that
    // a hung backend doesn't sit forever in flight).
    const timeoutMs = 10 * 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuter = (): void => controller.abort();
    signal.addEventListener("abort", onOuter);

    try {
      const res = await fetch(`${ANON_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 4096,
        }),
        signal: controller.signal,
      });
      // POST resolved: server has accepted the prompt and a model run
      // is queued. Coordinator advances from `dispatched` (stage 1) to
      // `received` (stage 2).
      setStage("received");
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return {
          body: `Zen API returned ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}.`,
          error: true,
          alias,
        };
      }
      // Body parse begins: the model is streaming generation back into
      // the response. Coordinator advances to `working` (stage 3).
      setStage("working");
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
        model?: string;
      };
      // Body fully parsed; we have the assistant text. Coordinator
      // advances to `writing` (stage 4) - "composing the reply" in
      // the user-facing 5-stage vocabulary even though the bridge is
      // really just packaging the response for the inbound envelope.
      setStage("writing");
      const choice = data?.choices?.[0]?.message;
      const text = choice?.content || choice?.reasoning_content || "";
      const actualModel = data?.model || model;
      return {
        body:
          actualModel && actualModel !== model
            ? `${text}\n\n[routed via ${actualModel}]`
            : text,
        alias,
      };
    } catch (err) {
      if (signal.aborted) throw err;
      if (controller.signal.aborted) {
        return {
          body:
            `Dispatch to ${alias} exceeded the ${Math.round(timeoutMs / 60_000)}-minute timeout. ` +
            "The backend may still be processing; reissue the prompt if you still need the answer.",
          error: true,
          alias,
        };
      }
      return {
        body: `One-shot dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
        alias,
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuter);
    }
  }

  /** Session-attached path. POSTs the prompt to opencode serve's
   * `/session/{id}/message` and reads the final assistant text directly
   * from the POST response body. opencode serve buffers the full turn
   * into a single response payload, so the POST itself returns the
   * assistant turn's parts - no separate GET poll loop is required.
   *
   * Timeout: a single AbortController combines the engine's outer
   * shutdown signal with our 10-minute hard cap. Local-LLM dispatches
   * can legitimately take minutes (cold prompt, low GPU power) so the
   * cap is generous; anything longer is a hang and the user gets an
   * "exceeded timeout" envelope they can act on rather than a
   * silent indefinite wait. */
  private async runSessionAttached(
    _dispatchId: string,
    sessionAlias: string,
    prompt: string,
    cfg: OpenCodeRoutesConfigSlice | null,
    signal: AbortSignal,
    setStage: (s: HeartbeatStage) => void
  ): Promise<DispatchResult> {
    const aliasMap = readAliasMap();
    const entry = aliasMap[this.target]?.[sessionAlias];
    if (!entry) {
      return {
        body: `Session alias '${sessionAlias}' not found for target=${this.target}.`,
        error: true,
      };
    }
    const serveUrl = cfg?.openCodeServerUrl;
    if (!serveUrl) {
      return {
        body: "opencode serve is not running. Enable OpenCode in WAT321 settings.",
        error: true,
      };
    }
    const sessionId = entry.sessionId;
    const targetKind = this.target === "local" ? "local" : "remote";
    const inst = entry.instanceId
      ? findInstance(cfg, entry.instanceId, null)
      : findInstance(cfg, null, targetKind);
    const alias = inst?.alias || (this.target === "local" ? "Local LLM" : "OpenCode");
    const modelRef =
      this.target === "local"
        ? { providerID: "llama.cpp", modelID: "local" }
        : inst?.model
          ? { providerID: inst.harnessProviderID || "zen", modelID: inst.model }
          : null;

    // 10-minute hard cap on the POST. Long enough for cold local
    // models, short enough that a hung backend doesn't sit in flight
    // forever. We chain to the engine's outer signal so VS Code
    // shutdown aborts the call too.
    const timeoutMs = 10 * 60_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuter = (): void => controller.abort();
    signal.addEventListener("abort", onOuter);

    try {
      const res = await fetch(
        `${serveUrl}/session/${sessionId}/message`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent: WAT321_RESEARCH_AGENT,
            parts: [{ type: "text", text: prompt }],
            ...(modelRef ? { providerID: modelRef.providerID, modelID: modelRef.modelID } : {}),
          }),
          signal: controller.signal,
        }
      );
      // POST resolved: opencode serve accepted the prompt and the
      // model run is queued. Coordinator advances from `dispatched`
      // (stage 1) to `received` (stage 2).
      setStage("received");
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return {
          body: `opencode serve returned ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}.`,
          error: true,
          alias,
        };
      }
      // Body parse begins: opencode serve buffers the assistant turn
      // and streams it back in one payload, so `await res.json()` is
      // where the actual model wait happens. Coordinator advances to
      // `working` (stage 3).
      setStage("working");
      const data = (await res.json()) as {
        parts?: Array<{ type?: string; text?: string }>;
      };
      // Body parsed; assistant text is in hand. Coordinator advances
      // to `writing` (stage 4).
      setStage("writing");
      const parts = Array.isArray(data?.parts) ? data.parts : [];
      const text = parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n\n");
      return {
        body: text || "(no assistant text in response)",
        alias,
      };
    } catch (err) {
      if (signal.aborted) {
        // Outer shutdown - rethrow so the OutboundWatcher writes the
        // standard "cancelled by shutdown" envelope.
        throw err;
      }
      if (controller.signal.aborted) {
        return {
          body:
            `Dispatch to ${alias} exceeded the ${Math.round(timeoutMs / 60_000)}-minute timeout. ` +
            "The backend may still be processing; reissue the prompt if you still need the answer. " +
            "If this happens repeatedly the model is hung - restart the local server or check the model's health.",
          error: true,
          alias,
        };
      }
      return {
        body: `Session dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
        alias,
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuter);
    }
  }
}

/** Resolve the session alias the dispatcher should target. Explicit
 * `session` on the envelope wins; otherwise read the active alias
 * from disk. Returns null when no session is configured (one-shot
 * path). The envelope carries an explicit `sessionAlias` field
 * populated from the caller's `session` arg on `wat321_ask`; that
 * wins over the disk-stored active alias so a caller can target a
 * specific session even when the active is something else. */
function readActiveAlias(
  target: "opencode" | "local",
  env: { sessionAlias?: string }
): string | null {
  if (typeof env.sessionAlias === "string" && env.sessionAlias.length > 0) {
    return env.sessionAlias;
  }
  const map = readAliasMap();
  const active = map.activeAliases?.[target];
  if (typeof active === "string" && active.length > 0) {
    return active;
  }
  return null;
}

/** Factory that activation code calls to build the dispatcher for a
 * given target. Symmetric with Codex's dispatcher factory in
 * `WAT321_EPIC_HANDSHAKE/index.ts` so future per-target dispatchers
 * follow the same shape. No logger parameter today - the dispatcher
 * surfaces errors via the inbound envelope's `error: true` flag,
 * which is what the user actually sees. */
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
