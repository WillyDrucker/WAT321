import {
  ANON_BASE_URL,
  DEFAULT_TIMEOUT_SEC,
  SESSION_CREATE_TIMEOUT_MS,
  WAT321_RESEARCH_AGENT,
  errorResult,
  fetchWithTimeout,
} from "./common.mjs";
import {
  nextAlias,
  readAliases,
  writeAliases,
} from "./aliases.mjs";
import { findInstance, readServeUrl } from "./config.mjs";
import { withOpenCodeHeartbeat } from "./heartbeat.mjs";
import { tapOpenCodeEvents } from "./sse.mjs";
import { postSessionMessage } from "./sessions.mjs";

/**
 * `wat321_ask` dispatch handler. Routes prompts to one of:
 *   - retrieveLatestSessionMessage: empty prompt + session = re-emit
 *     last assistant turn without paying for another generation.
 *   - session-attached: explicit alias or auto-resolved active alias,
 *     posts to `/session/{id}/message` with SSE-tap for live progress.
 *   - one-shot anonymous Zen: target=opencode falls through here when
 *     no instance/session is resolved. target=local refuses to fall
 *     through (catalog model is empty by design; would silently route
 *     to anonymous Big Pickle, a routing bug).
 */

/** POST a chat completion to opencode.ai's anonymous Zen endpoint. */
async function anonymousChatCompletion(model, prompt, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const messages = [{ role: "user", content: prompt }];
    const res = await fetch(`${ANON_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 4096,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, error: `Zen API returned ${res.status}: ${await res.text().catch(() => "")}` };
    }
    const data = await res.json();
    const choice = data?.choices?.[0]?.message;
    const content = choice?.content || "";
    const reasoning = choice?.reasoning_content || "";
    const text = content.length > 0 ? content : reasoning;
    const actualModel = data?.model || model;
    return { ok: true, text, actualModel, cost: data?.cost ?? null };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Re-read the latest assistant message from a session without
 * sending anything new. Saves a generation roundtrip. */
async function retrieveLatestSessionMessage(target, sessionAlias) {
  const map = readAliases();
  const aliasEntry = map[target]?.[sessionAlias];
  if (!aliasEntry) {
    return errorResult(
      `Session alias '${sessionAlias}' not found for target=${target}.`
    );
  }
  const sessionId = aliasEntry.sessionId;
  const serveUrl = readServeUrl();
  if (serveUrl === null) {
    return errorResult(
      "opencode serve is not running. Enable OpenCode in WAT321 settings."
    );
  }
  try {
    const res = await fetch(`${serveUrl}/session/${sessionId}/message`);
    if (!res.ok) {
      return errorResult(
        `Could not fetch session messages: opencode serve returned ${res.status}.`
      );
    }
    const messages = await res.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        content: [{ type: "text", text: `Session ${sessionAlias} has no messages yet.` }],
      };
    }
    const latest = messages[messages.length - 1];
    const parts = Array.isArray(latest?.parts) ? latest.parts : [];
    const text = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n\n");
    if (!text) {
      return {
        content: [
          {
            type: "text",
            text: `Session ${sessionAlias} latest message has no text parts (role=${latest?.info?.role ?? "?"}).`,
          },
        ],
      };
    }
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return errorResult(`Session message fetch failed: ${err?.message || String(err)}`);
  }
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

  const timeoutSec =
    typeof args?.timeout_sec === "number" && Number.isFinite(args.timeout_sec)
      ? args.timeout_sec
      : DEFAULT_TIMEOUT_SEC;
  const timeoutMs = Math.max(5_000, timeoutSec * 1000);

  const instanceId = typeof args?.instance_id === "string" ? args.instance_id : null;

  // Resolve session: explicit alias wins, else fall back to the
  // active alias the EH menu tracks for this target. Lets callers
  // omit `session` and dispatch through whatever is marked active.
  let resolvedAlias = sessionAlias;
  if (resolvedAlias === null) {
    const aliasMap = readAliases();
    const active = aliasMap.activeAliases?.[target] ?? null;
    if (active && aliasMap[target]?.[active]) {
      resolvedAlias = active;
    }
  }

  // Codex-flow auto-create: caller omitted `session` and no active
  // alias is set. Spawn a fresh opencode session, persist as the new
  // active alias, continue into the session-attached path. Without
  // this, a RESET from the menu would leave the next prompt unable to
  // dispatch (the session-attached branch errors on missing alias).
  if (sessionAlias === null && resolvedAlias === null) {
    const serveUrl = readServeUrl();
    if (serveUrl === null) {
      return errorResult(
        "opencode serve is not running. Enable OpenCode in WAT321 settings, then retry."
      );
    }
    const targetKind = target === "local" ? "local" : "remote";
    const autoInstance = findInstance(instanceId, targetKind);
    if (target === "local" && !autoInstance) {
      return errorResult(
        "target=local requires a configured local catalog entry. Set Local Endpoint in WAT321 settings, then retry."
      );
    }
    const body = {};
    if (autoInstance?.model) {
      body.model = {
        id: autoInstance.model,
        providerID: autoInstance.harnessProviderID || "zen",
      };
    }
    try {
      const res = await fetchWithTimeout(
        `${serveUrl}/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        SESSION_CREATE_TIMEOUT_MS
      );
      if (!res.ok) {
        return errorResult(
          `Auto-create session failed: opencode serve returned ${res.status}.`
        );
      }
      const data = await res.json();
      const newSessionId = data?.id;
      if (!newSessionId) {
        return errorResult("Auto-create session failed: opencode serve returned no id.");
      }
      // Reread alias map after the async POST. Concurrent dispatches
      // could have raced; computing `nextAlias` against a stale
      // snapshot would clobber an alias another request just wrote.
      const refreshed = readAliases();
      refreshed[target] = refreshed[target] || {};
      const newAlias = nextAlias(target);
      refreshed[target][newAlias] = {
        sessionId: newSessionId,
        instanceId: autoInstance?.id ?? null,
      };
      refreshed.activeAliases = refreshed.activeAliases || {
        opencode: null,
        local: null,
      };
      refreshed.activeAliases[target] = newAlias;
      writeAliases(refreshed);
      resolvedAlias = newAlias;
    } catch (err) {
      return errorResult(`Auto-create session failed: ${err?.message || String(err)}`);
    }
  }

  // Session-attached path: lookup alias, POST with SSE-tap for live
  // progress on the heartbeat.
  if (resolvedAlias !== null) {
    const map = readAliases();
    const aliasEntry = map[target]?.[resolvedAlias];
    if (!aliasEntry) {
      return errorResult(
        `Session alias '${resolvedAlias}' not found for target=${target}. Create it first via wat321_session({target:'${target}', action:'create'}).`
      );
    }
    const sessionId = aliasEntry.sessionId;
    const serveUrl = readServeUrl();
    if (serveUrl === null) {
      return errorResult(
        `opencode serve is not running. Enable OpenCode in WAT321 settings, then retry.`
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
      // Pass null (not the bare target keyword) when no real instance
      // is resolved. The heartbeat writer skips last-used.json on a
      // null/keyword instanceId so the widget's `activeInstanceFrom`
      // doesn't silently fall back to `activeInstanceId` (typically
      // Big Pickle) after a Local LLM dispatch - the user reads that
      // as "I dispatched to Local LLM but the widget jumped to Big
      // Pickle". A null id here is a true outcome: we couldn't pin
      // the dispatch to a catalog entry, so the widget should keep
      // showing the prior last-used entry (or `activeInstanceId` if
      // none exists), not invent one.
      instanceId: sessionInstance?.id || null,
      dataRetention: sessionInstance?.dataRetention || (target === "local" ? "local" : "retained"),
      model: sessionInstance?.model || "",
      timeoutMs,
      // target + waitMode plumb through so withOpenCodeHeartbeat can
      // write the engine heartbeat the bridge stage coordinator
      // reads. Without these, sync dispatches leave the bridge widget
      // blank instead of animating the 5-stage walker.
      target,
      waitMode: "standard",
    };
    // Per-message model binding. Local: hardcoded (catalog model is
    // empty by design - llama.cpp ignores the field - but OpenCode's
    // dispatch path needs an explicit {providerID, modelID} pair to
    // take the structured-tool-call route reliably). Remote: route
    // the active Zen model. Sending the binding every turn pins
    // behavior to the user's selected route.
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
      const tap = await tapOpenCodeEvents(serveUrl, sessionId, updateProgress);
      try {
        return await postSessionMessage(
          serveUrl,
          sessionId,
          prompt,
          timeoutMs,
          modelRef,
          WAT321_RESEARCH_AGENT
        );
      } finally {
        tap.stop();
      }
    });
    if (!result.ok) {
      return errorResult(`Session dispatch failed: ${result.error}`);
    }
    return { content: [{ type: "text", text: result.text }] };
  }

  // One-shot path. opencode falls back to the anonymous Zen big-pickle
  // slug when no instance is resolved. local refuses to fall through:
  // catalog model is blank by design (llama.cpp ignores model id), so
  // a missing instance + blank model would silently route to anonymous
  // Big Pickle.
  const instance = findInstance(instanceId);
  if (target === "local") {
    if (!instance) {
      return errorResult(
        "target=local requires a resumable session. Create one with wat321_session({target:'local', action:'create'}) and pass session=alias on wat321_ask."
      );
    }
    return errorResult(
      "target=local one-shot dispatch is not supported (llama.cpp model ids are server-side). Use wat321_session to create a local session, then wat321_ask({target:'local', session:'S1', prompt:'...'})."
    );
  }
  const modelSlug = instance?.model || "big-pickle";
  const oneShotMeta = {
    alias: instance?.alias || "Big Pickle",
    instanceId: instance?.id || "big-pickle",
    dataRetention: instance?.dataRetention || "retained",
    model: modelSlug,
    timeoutMs,
    target,
    waitMode: "standard",
  };
  const result = await withOpenCodeHeartbeat(oneShotMeta, () =>
    anonymousChatCompletion(modelSlug, prompt, timeoutMs)
  );
  if (!result.ok) {
    return errorResult(`One-shot dispatch failed: ${result.error}`);
  }
  let text = result.text;
  if (result.actualModel && result.actualModel !== modelSlug) {
    text += `\n\n[routed via ${result.actualModel}; cost: ${result.cost ?? "?"}]`;
  }
  return { content: [{ type: "text", text }] };
}
