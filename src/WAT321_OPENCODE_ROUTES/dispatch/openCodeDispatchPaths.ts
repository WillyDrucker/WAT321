import type { DispatchResult } from "../../engine/dispatcher/dispatcherTypes";
import { WAT321_RESEARCH_AGENT } from "../../shared/providers/opencode/configBuilder";
import { readAliases, SESSION_ALIASES_PATH } from "../../shared/bridge/sessionAliases";
import {
  findRoutesInstance,
  type OpenCodeRoutesConfigSnapshot,
} from "../../shared/bridge/openCodeRoutesConfigSnapshot";
import type { BridgeStage } from "../../engine/bridgeTypes";

/**
 * HTTP dispatch implementations for OpenCode / Local LLM.
 * `runZenOneShot` posts to opencode.ai/zen anonymously (no session, no
 * auth) when no session alias resolves. `runSessionAttached` posts to
 * opencode serve's `/session/{id}/message` with the resolved session
 * id and instance metadata, and because opencode serve buffers the
 * whole assistant turn into the POST response no GET poll loop is
 * needed.
 *
 * Both walk the stage heartbeat (`dispatched` -> `received` ->
 * `working` -> `writing`) through the injected `setStage` so the
 * stage coordinator advances past `working` on every non-Codex
 * dispatch, and the parent dispatcher's `run()` pushes `complete`
 * after the path returns. Every POST has a 10-minute hard cap: long
 * enough for cold local models, short enough that a hung backend ends
 * in a structured timeout envelope instead of an indefinite wait.
 */

const ANON_BASE_URL = "https://opencode.ai/zen/v1";
/** Outer bound on one dispatch POST. Native fetch drops a connection
 * that stays silent for 5 minutes (headers or body), so a turn that
 * sends nothing for that long surfaces as `fetch failed` before this
 * timer fires. Lifting that cap needs a per-request dispatcher. */
const DISPATCH_TIMEOUT_MS = 10 * 60_000;

interface DispatchPathArgs {
  target: "opencode" | "local";
  prompt: string;
  cfg: OpenCodeRoutesConfigSnapshot | null;
  signal: AbortSignal;
  setStage: (s: BridgeStage) => void;
}

/** Anonymous one-shot via opencode.ai/zen. Used when no session
 * alias is resolved - common path for "ask Big Pickle" without the
 * user having created a session. Model selection follows the
 * resolved instance's `model` field - falls back to `big-pickle`. */
export async function runZenOneShot(
  args: DispatchPathArgs
): Promise<DispatchResult> {
  const { target, prompt, cfg, signal, setStage } = args;
  if (target === "local") {
    return {
      body: "Local LLM fire-and-forget requires a session. Create one via wat321_session({target:'local', action:'create'}), then retry.",
      error: true,
    };
  }
  const inst = findRoutesInstance(cfg, null, "remote");
  const model = inst?.model || "big-pickle";
  const alias = inst?.alias || "Big Pickle";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
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
    // POST resolved: server accepted the prompt and a model run is
    // queued. Advance from `dispatched` (1) to `received` (2).
    setStage("received");
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        body: `Zen API returned ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}.`,
        error: true,
        alias,
      };
    }
    // Body parse begins: the model is streaming generation back.
    // Advance to `working` (3).
    setStage("working");
    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string };
      }>;
      model?: string;
    };
    // Body parsed - assistant text in hand. Advance to `writing` (4).
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
          `Dispatch to ${alias} exceeded the ${Math.round(DISPATCH_TIMEOUT_MS / 60_000)}-minute timeout. ` +
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
 * assistant turn's parts - no separate GET poll loop is required. */
export async function runSessionAttached(
  args: DispatchPathArgs & { sessionAlias: string }
): Promise<DispatchResult> {
  const { target, prompt, cfg, signal, setStage, sessionAlias } = args;
  const aliasMap = readAliases(SESSION_ALIASES_PATH);
  const entry = aliasMap[target]?.[sessionAlias];
  if (!entry) {
    return {
      body: `Session alias '${sessionAlias}' not found for target=${target}.`,
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
  const targetKind = target === "local" ? "local" : "remote";
  const inst = entry.instanceId
    ? findRoutesInstance(cfg, entry.instanceId, null)
    : findRoutesInstance(cfg, null, targetKind);
  const alias = inst?.alias || (target === "local" ? "Local LLM" : "OpenCode");
  const modelRef =
    target === "local"
      ? { providerID: "llama.cpp", modelID: "local" }
      : inst?.model
        ? { providerID: inst.harnessProviderID || "zen", modelID: inst.model }
        : null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
  const onOuter = (): void => controller.abort();
  signal.addEventListener("abort", onOuter);

  try {
    const res = await fetch(`${serveUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: WAT321_RESEARCH_AGENT,
        parts: [{ type: "text", text: prompt }],
        ...(modelRef
          ? { providerID: modelRef.providerID, modelID: modelRef.modelID }
          : {}),
      }),
      signal: controller.signal,
    });
    setStage("received");
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        body: `opencode serve returned ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}.`,
        error: true,
        alias,
      };
    }
    // opencode serve buffers the assistant turn and streams it back
    // in one payload, so `await res.json()` is where the actual model
    // wait happens.
    setStage("working");
    const data = (await res.json()) as {
      parts?: Array<{ type?: string; text?: string }>;
    };
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
          `Dispatch to ${alias} exceeded the ${Math.round(DISPATCH_TIMEOUT_MS / 60_000)}-minute timeout. ` +
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
