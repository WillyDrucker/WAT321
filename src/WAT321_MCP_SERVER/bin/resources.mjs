import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as bridgeInbox from "./bridgeInbox.mjs";
import * as codex from "./codex.mjs";
import * as opencode from "./opencode/index.mjs";

/**
 * MCP resource surface for the unified `wat321` bridge. Resources are
 * read-only state Claude fetches on demand - catalog, sessions, inbox,
 * status, plus the bridge://docs/* reference markdown. Each resource
 * costs ~30-50 tokens in resources/list (URI + name + short
 * description); bodies stay out of Claude's context until Claude reads
 * them. The docs resources are how the lean wat321_ask / wat321_bridge
 * tool descriptions stay under ~300 tokens combined while still giving
 * Claude full guidance on first use - the tool descriptions point at
 * the doc URIs, Claude reads them once per session when it needs them,
 * and turns that never touch the bridge pay only the lean tool surface.
 *
 * Implementation is pure: caller threads catalog reads, last-used
 * sidecar lookup, and the enabled-target snapshot in via `deps` so
 * this file doesn't reach into channel.mjs's local state. Docs are
 * loaded once at module init from `bin/docs/*.md` colocated with this
 * file; the installer copies them into `~/.wat321/bridge/bin/docs/`
 * alongside the .mjs files.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "docs");

/** Read a doc file at module init. Failures fall back to a short
 * placeholder so a missing doc doesn't break the resource handler -
 * the agent still sees the URI in resources/list, the read just
 * returns the fallback. */
function loadDoc(fileName) {
  try {
    return readFileSync(join(DOCS_DIR, fileName), "utf8");
  } catch {
    return `(WAT321 doc \`${fileName}\` not found in bridge install. Reinstall the extension or run the Reset WAT321 command to re-extract bin assets.)`;
  }
}

const DISPATCH_DOC = loadDoc("dispatch.md");
const DISPATCH_ROUTING_DOC = loadDoc("dispatch-routing.md");
const DISPATCH_ERRORS_DOC = loadDoc("dispatch-errors.md");
const DISPATCH_JUDGEMENT_DOC = loadDoc("dispatch-judgement.md");
const INBOX_DOC = loadDoc("inbox.md");

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
    uri: "bridge://inbox/opencode",
    name: "OpenCode inbox",
    description: "Pending fire-and-forget replies from OpenCode-aliased models.",
    mimeType: "application/json",
  },
  {
    uri: "bridge://inbox/local",
    name: "Local LLM inbox",
    description: "Pending fire-and-forget replies from Local LLM.",
    mimeType: "application/json",
  },
  {
    uri: "bridge://status",
    name: "Bridge status",
    description: "Daemon health, last-used backend, paused state.",
    mimeType: "application/json",
  },
  {
    uri: "bridge://docs/dispatch",
    name: "Dispatch (core)",
    description: "Required first read before wat321_ask: wait modes + retrieval contract.",
    mimeType: "text/markdown",
  },
  {
    uri: "bridge://docs/dispatch/routing",
    name: "Dispatch routing",
    description: "Alias resolution, target capability matrix, sticky-flag mechanics.",
    mimeType: "text/markdown",
  },
  {
    uri: "bridge://docs/dispatch/errors",
    name: "Dispatch errors",
    description: "Error patterns and recovery without looping.",
    mimeType: "text/markdown",
  },
  {
    uri: "bridge://docs/dispatch/judgement",
    name: "Dispatch judgement",
    description: "Optional. When to override sticky Adaptive with explicit fire_and_forget on implicit user intent.",
    mimeType: "text/markdown",
  },
  {
    uri: "bridge://docs/inbox",
    name: "Inbox reference",
    description: "Required reading before wat321_bridge: drain mechanics, why never to read inbox files directly.",
    mimeType: "text/markdown",
  },
];

/** Filter the resource list by enabled target so Claude does not see
 * resources for backends the user has turned off. Zero-surface-when-
 * disabled is the contract `buildTools` enforces; this function mirrors
 * it for the resource catalog so a user with every target disabled
 * pays nothing in either surface.
 *
 * Gating rules:
 *   - `bridge://docs/dispatch` / `bridge://docs/inbox` - shown when any
 *     backend is enabled. Both docs cover all targets now that FF
 *     works for opencode/local in addition to Codex.
 *   - `bridge://instances` / `bridge://status` - shown when any backend
 *     is enabled. With all targets off the catalog is empty and the
 *     status payload only repeats the `enabled` flags, so the resource
 *     adds no signal.
 *   - Per-target resources stay gated on their own target's enable
 *     flag exactly as before.
 */
export function filterEnabledResources(enabled) {
  const anyEnabled =
    enabled.codex === true ||
    enabled.opencode === true ||
    enabled.local === true;
  return RESOURCE_DEFS.filter((r) => {
    if (r.uri.startsWith("bridge://docs/")) return anyEnabled;
    if (r.uri === "bridge://instances" || r.uri === "bridge://status") {
      return anyEnabled;
    }
    if (r.uri.includes("/codex") && !enabled.codex) return false;
    if (r.uri.includes("/opencode") && !enabled.opencode) return false;
    if (r.uri.includes("/local") && !enabled.local) return false;
    return true;
  });
}

/** Look up the declared mimeType for a given resource URI. Falls back
 * to `application/json` so existing callers without an entry continue
 * to read as JSON. The markdown docs declare `text/markdown` in their
 * RESOURCE_DEFS entries and rely on this lookup. */
export function resourceMimeType(uri) {
  const def = RESOURCE_DEFS.find((r) => r.uri === uri);
  return def?.mimeType ?? "application/json";
}

/** Resolve a `bridge://...` URI to its content body Claude reads.
 * JSON resources return stringified JSON; markdown docs return raw
 * markdown. Throws `Unknown resource URI` for any URI not in
 * `RESOURCE_DEFS`. */
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
  if (uri === "bridge://inbox/opencode" || uri === "bridge://inbox/local") {
    const target = uri.endsWith("/local") ? "local" : "opencode";
    return JSON.stringify(bridgeInbox.listNonCodexInboxResource(target), null, 2);
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
  if (uri === "bridge://docs/dispatch") return DISPATCH_DOC;
  if (uri === "bridge://docs/dispatch/routing") return DISPATCH_ROUTING_DOC;
  if (uri === "bridge://docs/dispatch/errors") return DISPATCH_ERRORS_DOC;
  if (uri === "bridge://docs/dispatch/judgement") return DISPATCH_JUDGEMENT_DOC;
  if (uri === "bridge://docs/inbox") return INBOX_DOC;
  throw new Error(`Unknown resource URI: ${uri}`);
}
