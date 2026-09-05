import { requestedTimeoutSec, timeoutMsFor } from "../dispatchTimeout.mjs";
import { errorResult, textResult } from "../mcpResults.mjs";
import { findInstance, readServeUrl } from "../routesConfig.mjs";
import { withOpenCodeHeartbeat } from "./heartbeat.mjs";
import {
  fetchLatestMessage,
  postSessionMessage,
  textOfParts,
  WAT321_RESEARCH_AGENT,
} from "./serveApi.mjs";
import { readAliases } from "./sessionAliases.mjs";
import { createAliasedSession } from "./sessions.mjs";
import { tapOpenCodeEvents } from "./sse.mjs";

/**
 * `wat321_ask` handler for the opencode and local targets. Routes a
 * prompt to one of:
 *   - retrieveLatestSessionMessage: empty prompt + session re-emits
 *     the last assistant turn without paying for another generation.
 *   - session-attached dispatch: the explicit alias, else the active
 *     alias the EH menu tracks, else a session auto-created on the
 *     spot. Posts to `/session/{id}/message` with an SSE tap for live
 *     progress on the heartbeat.
 * Every dispatch reaches OpenCode through a session, so the reply
 * keeps its conversation context and the widget shows the bound model.
 */

/** Re-read the latest assistant message from a session without
 * sending anything new. Saves a generation roundtrip. */
async function retrieveLatestSessionMessage(target, sessionAlias) {
  const aliasEntry = readAliases()[target]?.[sessionAlias];
  if (!aliasEntry) {
    return errorResult(`Session alias '${sessionAlias}' not found for target=${target}.`);
  }
  const serveUrl = readServeUrl();
  if (serveUrl === null) {
    return errorResult("opencode serve is not running. Enable OpenCode in WAT321 settings.");
  }
  const latest = await fetchLatestMessage(serveUrl, aliasEntry.sessionId);
  if (!latest.ok) return errorResult(latest.error);
  if (latest.message === null) {
    return textResult(`Session ${sessionAlias} has no messages yet.`);
  }
  const text = textOfParts(latest.message.parts);
  if (!text) {
    return textResult(
      `Session ${sessionAlias} latest message has no text parts (role=${latest.message?.info?.role ?? "?"}).`
    );
  }
  return textResult(text);
}

/** The alias to dispatch through: the explicit `session` arg, else
 * the active alias the EH menu tracks for this target. */
function resolveSessionAlias(target, sessionAlias) {
  if (sessionAlias !== null) return sessionAlias;
  const map = readAliases();
  const active = map.activeAliases?.[target] ?? null;
  return active && map[target]?.[active] ? active : null;
}

/** Post the prompt to the aliased session under the OpenCode
 * heartbeat, tapping the SSE stream so the widget renders live token
 * progress. */
async function dispatchToSession(target, alias, prompt, timeoutMs) {
  const aliasEntry = readAliases()[target]?.[alias];
  if (!aliasEntry) {
    return errorResult(
      `Session alias '${alias}' not found for target=${target}. Create it first via wat321_session({target:'${target}', action:'create'}).`
    );
  }
  const serveUrl = readServeUrl();
  if (serveUrl === null) {
    return errorResult(
      "opencode serve is not running. Enable OpenCode in WAT321 settings, then retry."
    );
  }
  // Prefer the bound instanceId so the widget shows the session's
  // actual model rather than the user's currently-active instance
  // (which can drift after the session was created). Legacy null
  // instanceId falls back to the target-kind-filtered active.
  const targetKind = target === "local" ? "local" : "remote";
  const sessionInstance =
    (aliasEntry.instanceId ? findInstance(aliasEntry.instanceId) : null) ||
    findInstance(null, targetKind) ||
    null;
  const meta = {
    alias: sessionInstance?.alias || (target === "local" ? "Local LLM" : "OpenCode"),
    // Null (not the bare target keyword) when no real instance is
    // resolved. The heartbeat writer skips last-used.json on a null
    // instanceId so the widget's `activeInstanceFrom` does not silently
    // fall back to `activeInstanceId` (typically Big Pickle) after a
    // Local LLM dispatch. A null id is a true outcome: the dispatch
    // could not be pinned to a catalog entry, so the widget keeps
    // showing the prior last-used entry rather than inventing one.
    instanceId: sessionInstance?.id || null,
    dataRetention:
      sessionInstance?.dataRetention || (target === "local" ? "local" : "retained"),
    model: sessionInstance?.model || "",
    timeoutMs,
    // target + waitMode let withOpenCodeHeartbeat write the engine
    // heartbeat the bridge stage coordinator reads. Without these,
    // sync dispatches leave the bridge widget blank instead of
    // animating the 5-stage walker.
    target,
    waitMode: "standard",
  };
  // Per-message model binding. Local: hardcoded (the catalog model is
  // empty by design since llama.cpp ignores the field, but OpenCode's
  // dispatch path needs an explicit {providerID, modelID} pair to
  // take the structured-tool-call route reliably). Remote: the active
  // Zen model. Sending the binding every turn pins behavior to the
  // user's selected route.
  const modelRef =
    target === "local"
      ? { providerID: "llama.cpp", modelID: "local" }
      : sessionInstance?.model
        ? {
            providerID: sessionInstance.harnessProviderID || "zen",
            modelID: sessionInstance.model,
          }
        : null;
  const result = await withOpenCodeHeartbeat(meta, async (updateProgress) => {
    const tap = await tapOpenCodeEvents(serveUrl, aliasEntry.sessionId, updateProgress);
    try {
      return await postSessionMessage(
        serveUrl,
        aliasEntry.sessionId,
        prompt,
        timeoutMs,
        modelRef,
        WAT321_RESEARCH_AGENT
      );
    } finally {
      tap.stop();
    }
  });
  if (!result.ok) return errorResult(`Session dispatch failed: ${result.error}`);
  return textResult(result.text);
}

export async function handleAsk(args) {
  const target = args?.target;
  const prompt = typeof args?.prompt === "string" ? args.prompt : "";
  const sessionAlias = typeof args?.session === "string" ? args.session : null;
  if (prompt.trim().length === 0) {
    if (sessionAlias === null) {
      return errorResult(
        `Expected a non-empty 'prompt' argument for target=${target}. (Empty prompt is only valid with session=<alias> for retrieving the latest assistant message.)`
      );
    }
    return retrieveLatestSessionMessage(target, sessionAlias);
  }

  const timeoutMs = timeoutMsFor(requestedTimeoutSec(args));
  const instanceId = typeof args?.instance_id === "string" ? args.instance_id : null;

  let alias = resolveSessionAlias(target, sessionAlias);
  if (alias === null) {
    // Codex-flow auto-create: the caller omitted `session` and no
    // active alias is set. Spawn a fresh opencode session, persist it
    // as the new active alias, and continue into the session-attached
    // path. Without this, a RESET from the menu would leave the next
    // prompt unable to dispatch.
    const targetKind = target === "local" ? "local" : "remote";
    if (target === "local" && !findInstance(instanceId, targetKind)) {
      return errorResult(
        "target=local requires a configured local catalog entry. Set Local Endpoint in WAT321 settings, then retry."
      );
    }
    const created = await createAliasedSession(target, instanceId);
    if (!created.ok) {
      return errorResult(`Auto-create session failed: ${created.error}`);
    }
    alias = created.alias;
  }

  return dispatchToSession(target, alias, prompt, timeoutMs);
}
