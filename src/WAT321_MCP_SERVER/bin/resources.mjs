import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnabledTargets } from "./bridgeConfig.mjs";
import { listInboxResource } from "./codex/mailbox.mjs";
import { listNonCodexInboxResource } from "./nonCodexMailbox.mjs";
import { listSessionsResource } from "./opencode/sessions.mjs";
import { readCatalog, readLastUsedInstance } from "./routesConfig.mjs";

/**
 * MCP resource surface for the unified `wat321` bridge. Resources are
 * read-only state Claude fetches on demand: catalog, sessions, inbox,
 * status, plus the `bridge://docs/*` reference markdown. Each resource
 * costs ~30-50 tokens in resources/list (URI + name + short
 * description) and bodies stay out of Claude's context until read.
 * The docs resources are how the lean tool descriptions stay under
 * ~300 tokens combined while still giving Claude full guidance on
 * first use: the descriptions point at the doc URIs, Claude reads
 * them once per session when it needs them, and turns that never
 * touch the bridge pay only the lean tool surface.
 *
 * Docs load once at module init from `bin/docs/*.md` colocated with
 * this file. The installer copies them into `~/.wat321/bridge/bin/docs/`
 * alongside the .mjs files.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, "docs");

/** A missing doc falls back to a short placeholder so the resource
 * handler keeps working. The agent still sees the URI in
 * resources/list, the read just returns the fallback. */
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

const RESOURCE_DEFS = [
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
 * disabled is the contract `buildTools` enforces, mirrored here so a
 * user with every target disabled pays nothing in either surface.
 *
 * Gating rules:
 *   - `bridge://docs/*`, `bridge://instances`, `bridge://status` show
 *     when any backend is enabled. Both docs cover every target, and
 *     with all targets off the catalog is empty and the status
 *     payload only repeats the `enabled` flags.
 *   - Per-target resources gate on their own target's enable flag. */
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

/** Declared mimeType for a resource URI. Falls back to
 * `application/json` so a caller without an entry still reads as
 * JSON. The markdown docs declare `text/markdown` in RESOURCE_DEFS. */
export function resourceMimeType(uri) {
  const def = RESOURCE_DEFS.find((r) => r.uri === uri);
  return def?.mimeType ?? "application/json";
}

/** Resolve a `bridge://...` URI to the body Claude reads. JSON
 * resources return stringified JSON, markdown docs return raw
 * markdown. Throws `Unknown resource URI` for anything else. */
export async function readResourceContent(uri) {
  if (uri === "bridge://instances") {
    const catalog = readCatalog();
    return JSON.stringify(
      {
        instances: catalog.instances.map((i) => ({
          id: i.id,
          alias: i.alias,
          kind: i.kind,
          model: i.model,
          dataRetention: i.dataRetention,
          ready: i.apiKeyMissing !== true,
        })),
        activeInstanceId: catalog.activeInstanceId,
      },
      null,
      2
    );
  }
  if (uri === "bridge://sessions/opencode" || uri === "bridge://sessions/local") {
    const target = uri.endsWith("/local") ? "local" : "opencode";
    return JSON.stringify(await listSessionsResource(target), null, 2);
  }
  if (uri === "bridge://inbox/codex") {
    return JSON.stringify(await listInboxResource(), null, 2);
  }
  if (uri === "bridge://inbox/opencode" || uri === "bridge://inbox/local") {
    const target = uri.endsWith("/local") ? "local" : "opencode";
    return JSON.stringify(listNonCodexInboxResource(target), null, 2);
  }
  if (uri === "bridge://status") {
    const lastUsed = readLastUsedInstance();
    return JSON.stringify(
      {
        enabled: readEnabledTargets(),
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
