import {
  SESSION_CREATE_TIMEOUT_MS,
  errorResult,
  fetchWithTimeout,
  formatSessionDisplayName,
} from "./common.mjs";
import {
  nextAlias,
  readAliases,
  writeAliases,
} from "./aliases.mjs";
import { findInstance, readInstances, readServeUrl } from "./config.mjs";

/**
 * Session lifecycle (`wat321_session` tool) and the session list
 * resource (`bridge://sessions/{target}`). Plus `postSessionMessage`,
 * the dispatch-side POST helper used by handleAsk.
 */

/** POST to `/session/{id}/message`. The per-message `model` binding is
 * load-bearing: without it OpenCode falls through to default /
 * recent-model selection logic that can drop tool affordances or
 * change which sampling path runs. The empirical symptom is the model
 * hallucinating tool-call results inline as text instead of emitting
 * a structured `tool_calls` array. Sending the binding every turn
 * pins behavior to the route the user actually selected.
 *
 * `agent` selects which OpenCode agent profile runs the turn. The
 * default-built `build` agent is a coding assistant whose system prompt
 * suppresses URL guessing on non-coding questions (the source of the
 * "Local LLM gives up on webfetch" regression). WAT321 declares its own
 * `wat321-research` agent in `opencode.json` and dispatches against it
 * so research / current-events questions actually fire webfetch. The
 * agent's own system prompt subsumes any per-message tool-use bias the
 * caller might otherwise want to layer on. Pass null to fall through to
 * OpenCode's default agent. */
export async function postSessionMessage(serveUrl, sessionId, prompt, timeoutMs, modelRef, agent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = { parts: [{ type: "text", text: prompt }] };
    if (modelRef) body.model = modelRef;
    if (typeof agent === "string" && agent.length > 0) body.agent = agent;
    const res = await fetch(`${serveUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, error: `opencode serve returned ${res.status}: ${await res.text().catch(() => "")}` };
    }
    const data = await res.json();
    const parts = Array.isArray(data?.parts) ? data.parts : [];
    const text = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n\n");
    return { ok: true, text: text || "(no assistant text in response)" };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err?.message || String(err) };
  }
}

/** MCP resource backing `bridge://sessions/{target}` for target in
 * {opencode, local}. Returns alias entries enriched with display name
 * and the bound catalog instance (model + alias) when the alias has
 * a tracked instanceId. Legacy entries report `instance: null`. */
export async function listSessionsResource(target) {
  if (target !== "opencode" && target !== "local") {
    return { sessions: [], note: `Unknown target '${target}'.` };
  }
  const map = readAliases();
  const aliases = map[target] || {};
  const instances = readInstances();
  const sessions = Object.entries(aliases).map(([alias, entry]) => {
    const boundInstance = entry.instanceId
      ? instances.find((i) => i.id === entry.instanceId) ?? null
      : null;
    return {
      alias,
      sessionId: entry.sessionId,
      displayName: formatSessionDisplayName(target, alias),
      instance: boundInstance
        ? {
            id: boundInstance.id,
            alias: boundInstance.alias,
            model: boundInstance.model,
          }
        : null,
    };
  });
  return { sessions };
}

/** Handle `wat321_session({target, action, ...})`. Action enum is
 * create / delete / rename only - listing is exposed via the
 * `bridge://sessions/{target}` resource instead. */
export async function handleSession(args) {
  const target = args?.target;
  const action = args?.action;
  const map = readAliases();

  if (action === "create") {
    const serveUrl = readServeUrl();
    if (serveUrl === null) {
      return errorResult(
        "opencode serve is not running. Enable OpenCode in WAT321 settings."
      );
    }
    // Bind to a specific model on create so opencode's session list
    // reports the right model metadata. Without binding, the session
    // is created model-less and the list shows "model: undefined"
    // until the first message arrives - reads as broken.
    //
    // Target-kind filter: when no instance_id is supplied and the
    // user's active instance is the wrong kind (e.g. local-llm active
    // but creating an opencode session), skip the active and fall
    // back to a target-kind-matching instance. Without this, an
    // opencode session would inherit a local-kind instance's empty
    // model id and OpenCode would route to llama.cpp instead of the
    // cloud catalog.
    const instanceId = typeof args?.instance_id === "string" ? args.instance_id : null;
    const targetKind = target === "local" ? "local" : "remote";
    const instance = findInstance(instanceId, targetKind);
    const body = {};
    if (instance?.model) {
      body.model = {
        id: instance.model,
        providerID: instance.harnessProviderID || "zen",
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
        return errorResult(`opencode serve returned ${res.status} on /session create.`);
      }
      const data = await res.json();
      const sessionId = data?.id;
      if (!sessionId) return errorResult("opencode serve /session create did not return an id.");
      // Reread after the async POST. The pre-await `map` snapshot can
      // be stale if a concurrent dispatch wrote a new alias while we
      // waited; computing `nextAlias` against the stale copy would
      // collide with whatever just landed.
      const refreshed = readAliases();
      refreshed[target] = refreshed[target] || {};
      const alias = nextAlias(target);
      refreshed[target][alias] = { sessionId, instanceId: instance?.id ?? null };
      // Mark new session as the active alias so the EH menu's CURRENT
      // row reflects the just-created session without a manual switch.
      refreshed.activeAliases = refreshed.activeAliases || { opencode: null, local: null };
      refreshed.activeAliases[target] = alias;
      writeAliases(refreshed);
      const modelLabel = instance?.alias || data?.model?.id || "default model";
      const displayName = formatSessionDisplayName(target, alias);
      return {
        content: [
          {
            type: "text",
            text: `Created session "${displayName}" (model: ${modelLabel}) -> ${sessionId}. Use wat321_ask({target:'${target}', session:'${alias}', prompt:'...'}) to dispatch.`,
          },
        ],
      };
    } catch (err) {
      return errorResult(`opencode serve /session create failed: ${err?.message || String(err)}`);
    }
  }

  if (action === "delete" || action === "rename") {
    const alias = typeof args?.session === "string" ? args.session : null;
    if (alias === null) {
      return errorResult(`Action '${action}' requires a 'session' argument.`);
    }
    if (!map[target]?.[alias]) {
      return errorResult(`Session alias '${alias}' not found for target=${target}.`);
    }
    if (action === "delete") {
      const sessionId = map[target][alias]?.sessionId;
      delete map[target][alias];
      // Clearing the active when we delete it lets the next dispatch
      // fall back to "create on first use" (CURRENT row blank).
      map.activeAliases = map.activeAliases || { opencode: null, local: null };
      if (map.activeAliases[target] === alias) {
        map.activeAliases[target] = null;
      }
      writeAliases(map);
      return {
        content: [
          {
            type: "text",
            text: `Deleted alias ${alias}. The OpenCode session (${sessionId}) is retained in opencode.db for recovery.`,
          },
        ],
      };
    }
    const newName = typeof args?.new_name === "string" ? args.new_name : null;
    if (newName === null) {
      return errorResult("Rename requires a 'new_name' argument.");
    }
    if (map[target][newName]) {
      return errorResult(`Alias '${newName}' is already in use.`);
    }
    map[target][newName] = map[target][alias];
    delete map[target][alias];
    map.activeAliases = map.activeAliases || { opencode: null, local: null };
    if (map.activeAliases[target] === alias) {
      map.activeAliases[target] = newName;
    }
    writeAliases(map);
    return {
      content: [{ type: "text", text: `Renamed ${alias} -> ${newName}.` }],
    };
  }

  return errorResult(`Unknown action '${action}'. Expected create, delete, or rename.`);
}
