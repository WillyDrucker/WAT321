#!/usr/bin/env node
/**
 * WAT321 unified MCP server entry. Registered as `wat321` at project
 * scope on every workspace where Epic Handshake is enabled. Tool
 * surface plus MCP resources for read-only state:
 *
 *   wat321_ask         - alias-driven dispatch (router resolves)
 *   wat321_session     - session lifecycle for opencode/local (action enum)
 *   wat321_bridge      - single-purpose inbox drain
 *
 *   bridge://instances         - catalog of configured backends
 *   bridge://sessions/{target} - session aliases per target
 *   bridge://inbox/{target}    - pending late replies (peek, not drain)
 *   bridge://status            - daemon health, last-used backend
 *   bridge://docs/*            - dispatch and inbox reference
 *
 * MCP surface philosophy: STAY LEAN. Every tool registered here adds
 * its description + inputSchema to every Claude session's context
 * forever (cached on the first turn but billed against the budget).
 * Three tools is the cap. New capabilities prefer in order:
 *   1. Extending an existing tool's response shape or action enum
 *      (zero surface growth, e.g. `wat321_session.action` covers
 *      create / delete / rename in one tool)
 *   2. A standalone script under `bin/` invoked via Bash
 *   3. A new MCP resource (read-only, separate token bucket)
 *   4. Only when none of the above fit: a new tool, with description
 *      pulling its weight against the per-session cost
 *
 * Conditional registration: at startup, the server reads the enabled
 * targets from the per-client `bridge/config.json` (the extension
 * writes it on activate + on settings change). Disabled targets are
 * stripped from the tool surface AND from the resource list so users
 * pay zero context tokens for tools that would just error. Tool-list
 * refresh requires a VS Code reload, since MCP tool registrations are
 * snapshotted at connection time.
 *
 * Module map: `toolCatalog.mjs` declares the tools, `askRouter.mjs`
 * resolves aliases, `toolDispatch.mjs` routes a call into `codex/` or
 * `opencode/`, `bridgeDrain.mjs` combines the inboxes, and
 * `resources.mjs` serves the read-only surface.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readEnabledTargets } from "./bridgeConfig.mjs";
import { log } from "./channelLog.mjs";
import { errorResult } from "./mcpResults.mjs";
import {
  filterEnabledResources,
  readResourceContent,
  resourceMimeType,
} from "./resources.mjs";
import { buildTools } from "./toolCatalog.mjs";
import { dispatchCall } from "./toolDispatch.mjs";
import { workspaceId } from "./wat321Paths.mjs";

// MCP protocol version for the wat321 tool surface. Decoupled from the
// WAT321 extension release: it bumps only when a tool inputSchema or
// the resource layout changes in a non-additive way, so MCP clients
// negotiate compatibility independently of extension version stamps.
//
// `instructions` is the always-on routing hint. Deferred MCP tools
// surface by name only, so wat321_ask's description is not in context
// until Claude searches for it. This server-level string is always
// present and steers "ask Codex / another model" to the bridge instead
// of a raw CLI.
const server = new Server(
  { name: "wat321", version: "1.0" },
  {
    capabilities: { tools: {}, resources: {} },
    instructions:
      "Ask Codex or another model (OpenCode backends, the local LLM) through `wat321_ask`, not its raw CLI. If the tool is not loaded, load it via tool search. See bridge://docs/dispatch.",
  }
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

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: filterEnabledResources(readEnabledTargets()) };
});

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = req.params.uri;
  log("info", `resources/read uri=${uri}`);
  try {
    const text = await readResourceContent(uri);
    return {
      contents: [{ uri, mimeType: resourceMimeType(uri), text }],
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
  `wat321 unified bridge MCP server connected (wsId=${workspaceId()})`
);
