#!/usr/bin/env node
/**
 * WAT321 unified MCP server entry, registered as `wat321` at project
 * scope wherever Epic Handshake is enabled. Three tools (`wat321_ask`
 * alias-driven dispatch, `wat321_session` lifecycle for opencode/local,
 * `wat321_bridge` inbox drain) plus read-only resources:
 * `bridge://instances`, `bridge://sessions/{target}`,
 * `bridge://inbox/{target}` (peek, not drain), `bridge://status`, and
 * `bridge://docs/*`.
 *
 * STAY LEAN: every tool registered here bills its description and
 * schema to every Claude session forever, so three tools is the cap.
 * A new capability prefers, in order, an existing tool's response
 * shape or action enum, a standalone script under `bin/`, a new
 * resource (read-only, separate token bucket), and only then a tool.
 *
 * Registration is conditional: at startup the server reads the enabled
 * targets from the per-client `bridge/config.json` (written by the
 * extension on activate and on settings change) and strips disabled
 * targets from the tool and resource lists. MCP snapshots the tool list
 * at connection time, so a change needs a VS Code reload.
 *
 * Module map: `toolCatalog.mjs` declares the tools, `askRouter.mjs`
 * resolves aliases, `toolDispatch.mjs` routes a call into `codex/` or
 * `opencode/`, `bridgeDrain.mjs` combines the inboxes, `resources.mjs`
 * serves the read-only surface.
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
