import * as codex from "./codex.mjs";
import * as opencode from "./opencode/index.mjs";

/**
 * MCP resource surface for the unified `wat321` bridge. Resources are
 * read-only state Claude fetches on demand - catalog, sessions, inbox,
 * status. Each resource costs ~30-50 tokens in resources/list (URI +
 * name + short description); bodies stay out of Claude's context until
 * Claude reads them. Lets the catalog / sessions / inbox surfaces stay
 * available without paying for their descriptions in every turn.
 *
 * Implementation is pure: caller threads catalog reads, last-used
 * sidecar lookup, and the enabled-target snapshot in via `deps` so
 * this file doesn't reach into channel.mjs's local state.
 */

export const RESOURCE_DEFS = [
  {
    uri: "bridge://instances",
    name: "Bridge instances",
    description: "Catalog of available AI backends.",
    mimeType: "application/json",
  },
  {
    uri: "bridge://sessions/opencode",
    name: "OpenCode sessions",
    description: "Active OpenCode session aliases.",
    mimeType: "application/json",
  },
  {
    uri: "bridge://sessions/local",
    name: "Local LLM sessions",
    description: "Active Local LLM session aliases.",
    mimeType: "application/json",
  },
  {
    uri: "bridge://inbox/codex",
    name: "Codex inbox",
    description: "Pending late replies from Codex.",
    mimeType: "application/json",
  },
  {
    uri: "bridge://status",
    name: "Bridge status",
    description: "Daemon health, last-used backend, paused state.",
    mimeType: "application/json",
  },
];

/** Filter the resource list by enabled target so Claude does not
 * see resources for backends the user has turned off. */
export function filterEnabledResources(enabled) {
  return RESOURCE_DEFS.filter((r) => {
    if (r.uri.includes("/codex") && !enabled.codex) return false;
    if (r.uri.includes("/opencode") && !enabled.opencode) return false;
    if (r.uri.includes("/local") && !enabled.local) return false;
    return true;
  });
}

/** Resolve a `bridge://...` URI to a JSON string Claude reads. Throws
 * `Unknown resource URI` for any URI not in `RESOURCE_DEFS`. */
export async function readResourceContent(uri, deps) {
  if (uri === "bridge://instances") {
    const router = deps.makeRouter();
    return JSON.stringify(
      {
        instances: router.catalog.instances.map((i) => ({
          id: i.id,
          alias: i.alias,
          kind: i.kind,
          model: i.model,
          dataRetention: i.dataRetention,
          ready: i.apiKeyMissing !== true,
        })),
        activeInstanceId: router.catalog.activeInstanceId,
      },
      null,
      2
    );
  }
  if (uri === "bridge://sessions/opencode" || uri === "bridge://sessions/local") {
    const target = uri.endsWith("/local") ? "local" : "opencode";
    if (typeof opencode.listSessionsResource === "function") {
      return JSON.stringify(await opencode.listSessionsResource(target), null, 2);
    }
    return JSON.stringify({ sessions: [] }, null, 2);
  }
  if (uri === "bridge://inbox/codex") {
    if (typeof codex.listInboxResource === "function") {
      return JSON.stringify(await codex.listInboxResource(), null, 2);
    }
    return JSON.stringify({ inbox: [] }, null, 2);
  }
  if (uri === "bridge://status") {
    const lastUsed = deps.readLastUsedInstance();
    const enabled = deps.readEnabledTargets();
    return JSON.stringify(
      {
        enabled,
        lastUsed: lastUsed
          ? {
              instanceId: lastUsed.instanceId,
              alias: lastUsed.alias,
              at: lastUsed.at,
            }
          : null,
      },
      null,
      2
    );
  }
  throw new Error(`Unknown resource URI: ${uri}`);
}
