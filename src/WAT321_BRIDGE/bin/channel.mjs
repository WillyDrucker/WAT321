#!/usr/bin/env node
/**
 * WAT321 Bridge - Unified MCP Server (v1.4.1+)
 *
 * Single MCP entry point replacing the v1.4.0 split between
 * `wat321` (Epic Handshake / Codex) and `wat321-model-bridge`
 * (OpenCode Zen / local LLM). Registered with Claude as one server,
 * exposes 4 tools with a `target` parameter for routing:
 *
 *   wat321_ask({target, prompt, ...})       - dispatch a prompt
 *   wat321_inbox({target, ...})              - retrieve queued replies
 *   wat321_list({target?})                   - list configured instances
 *   wat321_session({target, action, ...})    - lifecycle for resumable sessions
 *
 * Token economics drove the unification: 7 distinct tools across 2
 * servers = ~2100 tokens of system-prompt registration cost per Claude
 * conversation. 4 unified tools = ~1200 tokens. Saves ~900 tokens
 * compounding across every turn until context turnover.
 *
 * Conditional registration: at startup, the server reads enabled
 * features (epicHandshake.enabled, modelBridge.enabled) from a config
 * file the extension writes on activate. The `target` enum on each
 * tool is narrowed to whichever subset is actually enabled. If neither
 * is enabled, the server registers zero tools - users pay zero context
 * tokens for tools that would just error.
 *
 * Settings change requires a VS Code reload to refresh the tool list -
 * MCP tool registrations are snapshotted at connection time anyway, so
 * this matches existing behavior across the codebase.
 *
 * Status: SCAFFOLDING ONLY. Stub handlers return informative errors
 * referencing the codepath that will replace them. The legacy two-
 * server registration remains active until the implementation lands.
 *
 * Implementation order (see WDDOCS/WAT321_V141_MCP_MERGE_PLAN.md):
 *   1. Codex handlers (port from src/WAT321_EPIC_HANDSHAKE/bin/channel.mjs)
 *   2. OpenCode handlers (use /session API discovered 2026-05-06)
 *   3. Local LLM handlers (defer until better local models tested)
 *   4. Installer wiring + legacy sweep
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as codex from "./codex.mjs";
import * as opencode from "./opencode.mjs";

const BRIDGE_DIR = join(homedir(), ".wat321", "bridge");
const CONFIG_PATH = join(BRIDGE_DIR, "config.json");
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

/** Build the dynamic `target` enum for a tool's input schema. Empty
 * array means the tool should not be registered at all. */
function targetEnumFor(tool, enabled) {
  const all = [];
  if (enabled.codex && tool !== "session") all.push("codex");
  if (enabled.opencode) all.push("opencode");
  if (enabled.local) all.push("local");
  return all;
}

/** Tool descriptor builder. Returns the MCP tool definition or null
 * when no targets apply (caller filters nulls before publishing). */
function buildTools(enabled) {
  const tools = [];

  const askTargets = targetEnumFor("ask", enabled);
  if (askTargets.length > 0) {
    tools.push({
      name: "wat321_ask",
      description:
        "Send a prompt to a configured WAT321 bridge target. Use this whenever the user asks to ask, prompt, tell, or check with another model.\n\nROUTING HINTS (map common phrases to args):\n- 'Ask Codex ...' / 'tell Codex ...' / 'check with Codex' -> {target:'codex'}\n- 'Ask Big Pickle ...' / 'ask Pickle ...' -> {target:'opencode', instance_id:'big-pickle'}\n- 'Ask GPT-5 Nano ...' / 'ask Nano ...' -> {target:'opencode', instance_id:'gpt-5-nano'}\n- 'Ask Ling ...' -> {target:'opencode', instance_id:'ling-2-6-flash'}\n- 'Ask Hy3 ...' -> {target:'opencode', instance_id:'hy3-preview-free'}\n- 'Ask Nemotron ...' -> {target:'opencode', instance_id:'nemotron-3-super-free'}\n- 'Ask MiniMax ...' -> {target:'opencode', instance_id:'minimax-m2-5-free'}\n- 'Ask OpenCode ...' / 'ask the cloud model' -> {target:'opencode'} (no instance_id, uses active)\n- 'Ask the local LLM ...' / 'ask my local model' -> {target:'local'}\n\nTARGET SEMANTICS:\n- target=codex: sync sub-Claude turn via Epic Handshake (Codex CLI dispatcher).\n- target=opencode: cloud model via opencode serve, free anonymous /zen/v1 fallback if no key. Resumable via session.\n- target=local: local llama.cpp / Ollama / vLLM endpoint. Resumable via session.\n\nPass session='S1' (or any alias from wat321_session) to continue a prior conversation on opencode/local. For codex, pass thread_name. Use wat321_list to discover available instances. Use wat321_session to manage session lifecycle.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: askTargets,
            description: "Which bridge to dispatch through.",
          },
          prompt: {
            type: "string",
            description: "The prompt body to send.",
          },
          session: {
            type: "string",
            description:
              "Resumable session alias (S1, S2, ...) for opencode/local. Created via wat321_session({action:'create'}). Omit to start a one-shot.",
          },
          thread_name: {
            type: "string",
            description:
              "Codex thread name (default 'S1'). Codex-specific equivalent of session for opencode/local.",
          },
          instance_id: {
            type: "string",
            description:
              "Specific instance id for opencode/local (e.g. 'big-pickle', 'local-llm'). Defaults to the click-menu's active instance.",
          },
          timeout_sec: {
            type: "integer",
            description: "Override the default per-target timeout.",
          },
        },
        required: ["target", "prompt"],
      },
    });
  }

  const inboxTargets = targetEnumFor("inbox", enabled);
  if (inboxTargets.length > 0) {
    tools.push({
      name: "wat321_inbox",
      description:
        "Retrieve queued replies from a WAT321 bridge target. target=codex returns pending late-reply envelopes from Epic Handshake. target=opencode/local returns completed asynchronous wat321_ask({async:true}) results. Pass requestId to target a specific entry; pass peek to view without removing.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: inboxTargets,
            description: "Which bridge inbox to read.",
          },
          requestId: {
            type: "string",
            description: "Specific async request id (opencode/local).",
          },
          peek: {
            type: "boolean",
            description: "View entries without removing them.",
          },
        },
        required: ["target"],
      },
    });
  }

  const listTargets = targetEnumFor("list", enabled);
  if (listTargets.length > 0) {
    tools.push({
      name: "wat321_list",
      description:
        "List configured instances and their status. Omit target to list every enabled bridge. Returns id, alias, kind, model, retention, and ready/needs-key flags. Use this to find a valid instance_id for wat321_ask.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: listTargets,
            description: "Restrict to one bridge. Omit to list all enabled.",
          },
        },
      },
    });
  }

  const sessionTargets = targetEnumFor("session", enabled);
  if (sessionTargets.length > 0) {
    tools.push({
      name: "wat321_session",
      description:
        "Manage resumable session aliases (S1, S2, ...) for opencode/local. Sessions are owned by OpenCode (stored in opencode.db) - WAT321 just maps the user-facing alias to the underlying session id. Codex doesn't use this tool; pass thread_name on wat321_ask instead.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: sessionTargets,
            description: "Which bridge to manage sessions for.",
          },
          action: {
            type: "string",
            enum: ["list", "create", "resume", "delete", "rename"],
            description: "Lifecycle action.",
          },
          session: {
            type: "string",
            description: "Session alias (S1, S2, ...). Required for resume/delete/rename.",
          },
          instance_id: {
            type: "string",
            description: "Instance for create. Defaults to the active instance.",
          },
          new_name: {
            type: "string",
            description: "New alias for rename.",
          },
        },
        required: ["target", "action"],
      },
    });
  }

  return tools;
}

const server = new Server(
  { name: "wat321", version: "1.4.1" },
  { capabilities: { tools: {} } }
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

/** Dispatch a tool call to the right per-target handler module.
 * Returns the MCP-shaped tool result. Unknown target / tool / handler
 * combinations return an isError result so the caller learns what
 * went wrong instead of timing out. */
async function dispatchCall(name, args) {
  const target = typeof args?.target === "string" ? args.target : null;
  if (target === null) {
    return errorResult(`Tool '${name}' requires a 'target' argument.`);
  }

  const targetModule =
    target === "codex"
      ? codex
      : target === "opencode" || target === "local"
        ? opencode
        : null;
  if (targetModule === null) {
    return errorResult(`Unknown target '${target}'. Expected codex, opencode, or local.`);
  }

  if (name === "wat321_ask") {
    return targetModule.handleAsk(args);
  }
  if (name === "wat321_inbox") {
    return targetModule.handleInbox(args);
  }
  if (name === "wat321_list") {
    return targetModule.handleList(args);
  }
  if (name === "wat321_session") {
    if (target === "codex") {
      return errorResult(
        "wat321_session does not apply to target=codex. Pass thread_name on wat321_ask instead."
      );
    }
    if (typeof targetModule.handleSession !== "function") {
      return errorResult(
        `Session handler for target='${target}' not yet ported.`
      );
    }
    return targetModule.handleSession(args);
  }

  return errorResult(`Unknown tool '${name}'.`);
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments || {};
  const target = typeof args.target === "string" ? args.target : null;
  log("info", `tools/call name=${name} target=${target}`);
  try {
    return await dispatchCall(name, args);
  } catch (err) {
    const msg = err?.message || String(err);
    log("error", `dispatch failed: ${msg}`);
    return errorResult(`wat321 bridge dispatch failed: ${msg}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log("info", "wat321 unified bridge MCP server connected");
