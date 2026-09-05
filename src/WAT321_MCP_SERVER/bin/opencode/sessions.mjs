import { formatSessionDisplayName } from "../bridgeConfig.mjs";
import { errorResult, textResult } from "../mcpResults.mjs";
import { findInstance, readInstances, readServeUrl } from "../routesConfig.mjs";
import { createSession } from "./serveApi.mjs";
import { bindNewSession, readAliases, writeAliases } from "./sessionAliases.mjs";

/**
 * Session lifecycle (`wat321_session` tool) and the session list
 * resource (`bridge://sessions/{target}`). `createAliasedSession` is
 * also the auto-create path `dispatch.mjs` takes when a prompt arrives
 * with no session and no active alias.
 */

/** Create an OpenCode session for `target` on the catalog instance
 * (an explicit id, else the target-kind-matching active or first
 * instance) and bind it as the new active alias.
 *
 * The target-kind filter matters when no instance_id is supplied and
 * the user's active instance is the wrong kind (local-llm active but
 * creating an opencode session). Without it the opencode session
 * would inherit the local instance's empty model id and OpenCode
 * would route to llama.cpp instead of the cloud catalog. */
export async function createAliasedSession(target, instanceId) {
  const serveUrl = readServeUrl();
  if (serveUrl === null) {
    return {
      ok: false,
      error: "opencode serve is not running. Enable OpenCode in WAT321 settings, then retry.",
    };
  }
  const targetKind = target === "local" ? "local" : "remote";
  const instance = findInstance(instanceId, targetKind);
  const created = await createSession(serveUrl, instance);
  if (!created.ok) return created;
  const alias = bindNewSession(target, created.id, instance?.id ?? null);
  return {
    ok: true,
    alias,
    sessionId: created.id,
    modelLabel: instance?.alias || created.modelId || "default model",
  };
}

/** MCP resource backing `bridge://sessions/{target}` for target in
 * {opencode, local}. Alias entries enriched with the display name and
 * the bound catalog instance (model + alias) when the alias has a
 * tracked instanceId. Legacy entries report `instance: null`. */
export async function listSessionsResource(target) {
  if (target !== "opencode" && target !== "local") {
    return { sessions: [], note: `Unknown target '${target}'.` };
  }
  const aliases = readAliases()[target] || {};
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

/** Handle `wat321_session({target, action, ...})`. The action enum is
 * create / delete / rename only. Listing is exposed via the
 * `bridge://sessions/{target}` resource instead. */
export async function handleSession(args) {
  const target = args?.target;
  const action = args?.action;

  if (action === "create") {
    const instanceId = typeof args?.instance_id === "string" ? args.instance_id : null;
    const created = await createAliasedSession(target, instanceId);
    if (!created.ok) return errorResult(created.error);
    const displayName = formatSessionDisplayName(target, created.alias);
    return textResult(
      `Created session "${displayName}" (model: ${created.modelLabel}) -> ${created.sessionId}. Use wat321_ask({target:'${target}', session:'${created.alias}', prompt:'...'}) to dispatch.`
    );
  }

  if (action === "delete" || action === "rename") {
    const map = readAliases();
    const alias = typeof args?.session === "string" ? args.session : null;
    if (alias === null) {
      return errorResult(`Action '${action}' requires a 'session' argument.`);
    }
    if (!map[target]?.[alias]) {
      return errorResult(`Session alias '${alias}' not found for target=${target}.`);
    }
    map.activeAliases = map.activeAliases || { opencode: null, local: null };
    if (action === "delete") {
      const sessionId = map[target][alias]?.sessionId;
      delete map[target][alias];
      // Clearing the active when we delete it lets the next dispatch
      // fall back to "create on first use" (CURRENT row blank).
      if (map.activeAliases[target] === alias) {
        map.activeAliases[target] = null;
      }
      writeAliases(map);
      return textResult(
        `Deleted alias ${alias}. The OpenCode session (${sessionId}) is retained in opencode.db for recovery.`
      );
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
    if (map.activeAliases[target] === alias) {
      map.activeAliases[target] = newName;
    }
    writeAliases(map);
    return textResult(`Renamed ${alias} -> ${newName}.`);
  }

  return errorResult(`Unknown action '${action}'. Expected create, delete, or rename.`);
}
