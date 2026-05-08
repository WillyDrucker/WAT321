#!/usr/bin/env node
/**
 * WAT321 unified MCP server entry. Registered as `wat321` at project
 * scope on every workspace where Epic Handshake is enabled. Tool
 * surface plus MCP resources for read-only state:
 *
 *   wat321_ask         - alias-driven dispatch (router resolves)
 *   wat321_session     - mutating session lifecycle (create/delete/rename)
 *
 *   bridge://instances         - catalog of configured backends
 *   bridge://sessions/{target} - session aliases per target
 *   bridge://inbox/codex       - pending Codex late replies
 *   bridge://status            - daemon health, last-used backend
 *
 * The router collapses target + instance routing into a free-form
 * `alias` string ("Big Pickle", "Codex", "Local LLM") with fuzzy
 * matching against the catalog. Total system-prompt overhead is
 * ~250-300 tokens.
 *
 * Conditional registration: at startup, the server reads enabled
 * features (epicHandshake.enabled, enableOpenCode) from the per-client
 * `bridge/config.json` (the extension writes it on activate + on
 * settings change). Disabled targets are stripped from the tool
 * surface AND from the resource list so users pay zero context
 * tokens for tools that would just error.
 *
 * Tool-list refresh requires a VS Code reload - MCP tool registrations
 * are snapshotted at connection time, same constraint for every MCP
 * client.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as codex from "./codex.mjs";
import * as opencode from "./opencode/index.mjs";
import { bridgeStateDir, openCodeRoutesStateDir } from "./paths.mjs";
import { decorateAskResult } from "./replyDecorator.mjs";
import {
  filterEnabledResources,
  readResourceContent,
} from "./resources.mjs";

const BRIDGE_DIR = bridgeStateDir();
const CONFIG_PATH = join(BRIDGE_DIR, "config.json");
const OPENCODE_ROUTES_CONFIG_PATH = join(openCodeRoutesStateDir(), "config.json");
const LOG_PATH = join(BRIDGE_DIR, "channel.log");
const LOG_MAX_BYTES = 50_000;

/** Best-effort log writer. Truncates the log when it crosses
 * LOG_MAX_BYTES to bound disk use; never throws into the MCP loop. */
function log(level, message) {
  try {
    if (!existsSync(dirname(LOG_PATH))) {
      mkdirSync(dirname(LOG_PATH), { recursive: true });
    }
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    writeFileSync(LOG_PATH, line, { flag: "a" });
    try {
      const stat = readFileSync(LOG_PATH, "utf8");
      if (stat.length > LOG_MAX_BYTES) {
        writeFileSync(LOG_PATH, stat.slice(-LOG_MAX_BYTES));
      }
    } catch {
      // best-effort
    }
  } catch {
    // best-effort
  }
}

/** Read enabled-feature flags from the config file the extension
 * writes on activate. Defaults to all-disabled when the file is
 * missing - the server still loads (so MCP registration succeeds)
 * but exposes zero tools until the user enables something. */
function readEnabledTargets() {
  const defaults = { codex: false, opencode: false, local: false };
  try {
    if (!existsSync(CONFIG_PATH)) return defaults;
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return {
      codex: parsed?.enabled?.codex === true,
      opencode: parsed?.enabled?.opencode === true,
      local: parsed?.enabled?.local === true,
    };
  } catch (err) {
    log("warn", `readEnabledTargets failed: ${err?.message || String(err)}`);
    return defaults;
  }
}

/** Read the OpenCode Routes catalog. Used by the router for alias
 * resolution and by the `bridge://instances` resource for Claude's
 * on-demand discovery. Returns the active instance id alongside so
 * the router can default `alias=null` calls to the user's preferred
 * routing target. */
function readCatalog() {
  const empty = { instances: [], activeInstanceId: null };
  try {
    if (!existsSync(OPENCODE_ROUTES_CONFIG_PATH)) return empty;
    const parsed = JSON.parse(readFileSync(OPENCODE_ROUTES_CONFIG_PATH, "utf8"));
    return {
      instances: Array.isArray(parsed?.instances) ? parsed.instances : [],
      activeInstanceId:
        typeof parsed?.activeInstanceId === "string" ? parsed.activeInstanceId : null,
    };
  } catch (err) {
    log("warn", `readCatalog failed: ${err?.message || String(err)}`);
    return empty;
  }
}

/** Bridge router. Resolves a free-form alias string ("Big Pickle",
 * "Codex", "Pickle" via fuzzy match) to a concrete dispatch target +
 * optional instance_id. Catalog-driven, deterministic, no LLM in the
 * loop - adding a new instance is a catalog edit and the router gets
 * it for free.
 *
 * Resolution order:
 *   1. Exact target keyword: "codex" / "opencode" / "local" (case-
 *      insensitive). Returns just `{target}` so the dispatch handler
 *      can pick the active instance for that target.
 *   2. Exact alias / id match against the catalog.
 *   3. Substring fuzzy match. Single hit returns it; multiple hits
 *      return `{ambiguous, candidates}` for Claude to disambiguate.
 *   4. Empty / null alias -> `{useDefault: true}` so the caller
 *      either falls back to last-used or active. */
function makeRouter() {
  const catalog = readCatalog();
  const targetKeywords = new Map([
    ["codex", "codex"],
    ["opencode", "opencode"],
    ["local", "local"],
    ["local llm", "local"],
    ["local-llm", "local"],
  ]);
  function instanceKindToTarget(kind) {
    return kind === "local" ? "local" : "opencode";
  }
  function resolve(alias) {
    if (alias === null || alias === undefined) {
      return { useDefault: true };
    }
    const norm = String(alias).trim().toLowerCase();
    if (norm.length === 0) return { useDefault: true };
    if (targetKeywords.has(norm)) {
      return { target: targetKeywords.get(norm) };
    }
    // Exact alias / id match.
    for (const inst of catalog.instances) {
      const a = String(inst.alias || "").toLowerCase();
      const id = String(inst.id || "").toLowerCase();
      if (a === norm || id === norm) {
        return { target: instanceKindToTarget(inst.kind), instance_id: inst.id };
      }
    }
    // Substring fuzzy match. Bias toward alias matches over id matches
    // (alias is what the user typed; id is the internal slug).
    const candidates = catalog.instances.filter((inst) => {
      const a = String(inst.alias || "").toLowerCase();
      const id = String(inst.id || "").toLowerCase();
      return a.includes(norm) || id.includes(norm);
    });
    if (candidates.length === 1) {
      const inst = candidates[0];
      return { target: instanceKindToTarget(inst.kind), instance_id: inst.id };
    }
    if (candidates.length > 1) {
      return {
        ambiguous: true,
        candidates: candidates.map((c) => c.alias || c.id),
      };
    }
    return { unknown: true, alias };
  }
  return { resolve, catalog };
}

/** Tool descriptor builder. Returns the MCP tool definitions exposed
 * to Claude. Two tools:
 *
 *   wat321_ask     - dispatch a prompt; alias picks the backend
 *   wat321_session - mutating session lifecycle (create/delete/rename)
 *
 * Read-only state (inbox, sessions list) lives on MCP resources (see
 * resources/list below) so Claude pays for those descriptions only
 * when the user asks. The unified router resolves alias
 * strings to concrete targets so Claude doesn't need to know the
 * target enum exists.
 *
 * Total tool surface ~250-300 tokens. */
function buildTools(enabled) {
  const tools = [];
  const anyEnabled = enabled.codex || enabled.opencode || enabled.local;
  if (!anyEnabled) return tools;

  // Bare-minimum tool description. Server router does the work; Claude
  // only needs to know "this is the ask tool, pass prompt + alias."
  // A handful of example aliases seed pattern recognition; the full
  // catalog is the bridge://instances resource for when the user asks.
  tools.push({
    name: "wat321_ask",
    description:
      "Ask another AI model. `alias` is who (e.g. 'Codex', 'Big Pickle', 'Local LLM') - fuzzy-matched, omit for default. See bridge://instances for full catalog. `session` continues a prior conversation.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Message to send." },
        alias: { type: "string", description: "Which backend." },
        session: { type: "string", description: "Session alias (S1, S2, ...)." },
        thread_name: { type: "string", description: "Codex thread name." },
        timeout_sec: { type: "integer", description: "Override timeout." },
      },
      required: ["prompt"],
    },
  });

  // Session mutations only - listing moved to bridge://sessions/{target}
  // resource. Description stays short; the action enum self-documents.
  if (enabled.opencode || enabled.local) {
    const sessionTargets = [];
    if (enabled.opencode) sessionTargets.push("opencode");
    if (enabled.local) sessionTargets.push("local");
    tools.push({
      name: "wat321_session",
      description:
        "Manage session aliases for opencode/local. To list, read bridge://sessions/{target}.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", enum: sessionTargets },
          action: { type: "string", enum: ["create", "delete", "rename"] },
          session: { type: "string", description: "Required for delete/rename." },
          instance_id: { type: "string", description: "For create." },
          new_name: { type: "string", description: "For rename." },
        },
        required: ["target", "action"],
      },
    });
  }

  return tools;
}

// MCP protocol version for the wat321_ask / wat321_session surface.
// Decoupled from the WAT321 extension release - bumps only when the
// tool inputSchema or resource layout changes in a non-additive way,
// which lets MCP clients negotiate compatibility independently of
// extension version stamps.
const server = new Server(
  { name: "wat321", version: "1.0" },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const enabled = readEnabledTargets();
  const tools = buildTools(enabled);
  log(
    "info",
    `tools/list: enabled=${JSON.stringify(enabled)} tool_count=${tools.length}`
  );
  return { tools };
});

/** Resolve a wat321_ask call's target via the router. Returns either
 * `{ target, instance_id? }` for dispatch, or an MCP error result
 * suitable for direct return. Backward-compat: still accepts an
 * explicit `target` arg if the caller bypasses the alias surface. */
function resolveAskTarget(args, enabled) {
  const router = makeRouter();
  const explicitTarget = typeof args?.target === "string" ? args.target : null;
  const explicitInstance =
    typeof args?.instance_id === "string" ? args.instance_id : null;
  const alias = typeof args?.alias === "string" ? args.alias : null;

  // Explicit target wins (back-compat for direct callers).
  if (explicitTarget !== null) {
    return {
      target: explicitTarget,
      instance_id: explicitInstance ?? undefined,
    };
  }

  const resolved = router.resolve(alias);
  if (resolved.ambiguous) {
    return {
      error: errorResult(
        `Alias '${alias}' is ambiguous - matched: ${resolved.candidates.join(", ")}. Be more specific.`
      ),
    };
  }
  if (resolved.unknown) {
    return {
      error: errorResult(
        `Alias '${resolved.alias}' is not a known backend. Read the bridge://instances resource for available aliases, or use a known target keyword (Codex / OpenCode / Local LLM).`
      ),
    };
  }
  if (resolved.useDefault) {
    // Default-route resolution: prefer the OpenCode Routes last-used
    // sidecar, then the active-instance preference, then Codex when
    // enabled. Mirrors what the widget shows so a default-aliased
    // call lands on whatever the user has been using most recently.
    const lastUsed = readLastUsedInstance();
    if (lastUsed?.instanceId) {
      const inst = router.catalog.instances.find((i) => i.id === lastUsed.instanceId);
      if (inst) {
        return {
          target: inst.kind === "local" ? "local" : "opencode",
          instance_id: inst.id,
        };
      }
    }
    if (router.catalog.activeInstanceId) {
      const inst = router.catalog.instances.find(
        (i) => i.id === router.catalog.activeInstanceId
      );
      if (inst) {
        return {
          target: inst.kind === "local" ? "local" : "opencode",
          instance_id: inst.id,
        };
      }
    }
    if (enabled.codex) return { target: "codex" };
    return {
      error: errorResult(
        "No alias passed and no default could be resolved. Pass alias='Codex' / 'Big Pickle' / etc., or set an active instance via the WAT321 widget."
      ),
    };
  }
  return { target: resolved.target, instance_id: resolved.instance_id };
}

/** Best-effort read of the OpenCode Routes last-used sidecar so a
 * default-alias dispatch routes to the most recently used backend
 * (matches the widget's last-used display). */
function readLastUsedInstance() {
  const path = join(openCodeRoutesStateDir(), "last-used.json");
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Dispatch a tool call to the right per-target handler module.
 * wat321_ask routes through the alias router; wat321_session is a
 * thin pass-through for opencode/local lifecycle mutations. Read-only
 * surfaces (inbox, list) moved to MCP resources. */
async function dispatchCall(name, args, enabled) {
  if (name === "wat321_ask") {
    const resolved = resolveAskTarget(args, enabled);
    if (resolved.error) return resolved.error;
    const target = resolved.target;
    // Enforce enabled-target gate even after the router resolves.
    // Cached Claude tool schemas can outlive a settings change that
    // disabled a target, and last-used / active fallbacks may point
    // at a target the user has since turned off. Refuse explicitly
    // rather than silently dispatching against a disabled tier.
    if (!enabled[target]) {
      return errorResult(
        `Target '${target}' is not enabled. Turn on the corresponding WAT321 setting (Epic Handshake for codex; OpenCode for opencode/local) and reload.`
      );
    }
    const targetModule =
      target === "codex" ? codex : target === "opencode" || target === "local" ? opencode : null;
    if (targetModule === null) {
      return errorResult(`Unknown target '${target}'.`);
    }
    // Forward to the existing handler with target + instance_id baked
    // back in. handleAsk's signature predates the router; rather than
    // refactor every call site we synthesize the legacy args shape.
    const forwardArgs = {
      ...args,
      target,
      ...(resolved.instance_id ? { instance_id: resolved.instance_id } : {}),
    };
    const askResult = await targetModule.handleAsk(forwardArgs);
    return decorateAskResult(askResult, args, target);
  }

  if (name === "wat321_session") {
    const target = typeof args?.target === "string" ? args.target : null;
    if (target === null) {
      return errorResult("wat321_session requires a 'target' argument.");
    }
    if (target === "codex") {
      return errorResult(
        "wat321_session does not apply to target=codex. Pass thread_name on wat321_ask instead."
      );
    }
    if (!enabled[target]) {
      return errorResult(
        `Target '${target}' is not enabled. Enable OpenCode (and a local endpoint for target=local) before managing sessions.`
      );
    }
    if (typeof opencode.handleSession !== "function") {
      return errorResult(`Session handler for target='${target}' not available.`);
    }
    return opencode.handleSession(args);
  }

  return errorResult(`Unknown tool '${name}'.`);
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments || {};
  const enabled = readEnabledTargets();
  const aliasOrTarget = args.alias || args.target || null;
  log("info", `tools/call name=${name} alias=${aliasOrTarget}`);
  try {
    return await dispatchCall(name, args, enabled);
  } catch (err) {
    const msg = err?.message || String(err);
    log("error", `dispatch failed: ${msg}`);
    return errorResult(`wat321 bridge dispatch failed: ${msg}`);
  }
});

// Resources are read-only state Claude fetches on demand (catalog,
// sessions, inbox, status). Definitions + readers live in
// `resources.mjs`; this file wires them to the MCP request handlers
// and threads the small set of internal helpers the readers need.

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: filterEnabledResources(readEnabledTargets()) };
});

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = req.params.uri;
  log("info", `resources/read uri=${uri}`);
  try {
    const text = await readResourceContent(uri, {
      makeRouter,
      readLastUsedInstance,
      readEnabledTargets,
    });
    return {
      contents: [{ uri, mimeType: "application/json", text }],
    };
  } catch (err) {
    const msg = err?.message || String(err);
    log("error", `resource read failed: ${msg}`);
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({ error: msg }, null, 2),
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(
  "info",
  `wat321 unified bridge MCP server connected (wsId=${process.env.WAT321_WORKSPACE_ID || "default"})`
);
