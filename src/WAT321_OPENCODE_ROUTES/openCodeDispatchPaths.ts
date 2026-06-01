import type { DispatchResult } from "../engine/dispatcher";
import type { HeartbeatStage } from "../engine/heartbeat";
import { WAT321_RESEARCH_AGENT } from "../shared/providers/opencode/configBuilder";
import {
  findInstance,
  readAliasMap,
  type OpenCodeRoutesConfigSlice,
} from "./openCodeDispatchConfig";

/**
 * HTTP dispatch implementations for OpenCode / Local LLM:
 *   - `runZenOneShot` posts to opencode.ai/zen anonymously (no
 *     session, no auth). Used when no session alias is resolved.
 *   - `runSessionAttached` posts to opencode serve's
 *     `/session/{id}/message` with the resolved session id +
 *     instance metadata. opencode serve buffers the full assistant
 *     turn into a single response payload so the POST response
 *     itself returns the assistant parts - no separate GET poll
 *     loop required.
 *
 * Both walk the 5-stage heartbeat (`dispatched` -> `received` ->
 * `working` -> `writing`) via the injected `setStage` callback so
 * the bridge stage coordinator advances past `working` (idx 2) on
 * every non-Codex dispatch. The final `complete` push happens in
 * the parent dispatcher's `run()` after the path returns
 * successfully.
 *
 * 10-minute hard cap on every POST: long enough for cold local
 * models, short enough that a hung backend doesn't sit forever in
 * flight. Anything longer is a hang; the user gets a structured
 * timeout envelope they can act on rather than a silent indefinite
 * wait.
 */

const ANON_BASE_URL = "https://opencode.ai/zen/v1";
const DISPATCH_TIMEOUT_MS = 10 * 60_000;
export const HTTP_DISPATCH_TIMEOUT_MS = DISPATCH_TIMEOUT_MS;

export interface DispatchPathArgs {
  target: "opencode" | "local";
  prompt: string;
  cfg: OpenCodeRoutesConfigSlice | null;
  signal: AbortSignal;
  setStage: (s: HeartbeatStage) => void;
}

/** Anonymous one-shot via opencode.ai/zen. Used when no session
 * alias is resolved - common path for "ask Big Pickle" without the
 * user having created a session. Model selection follows the
 * resolved instance's `model` field; falls back to `big-pickle`. */
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
  const inst = findInstance(cfg, null, "remote");
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
    // Body parsed; assistant text in hand. Advance to `writing` (4).
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
  const aliasMap = readAliasMap();
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
    ? findInstance(cfg, entry.instanceId, null)
    : findInstance(cfg, null, targetKind);
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
