#!/usr/bin/env node
/**
 * WAT321 unified MCP server entry. Registered as `wat321` at project
 * scope on every workspace where Epic Handshake is enabled. Tool
 * surface plus MCP resources for read-only state:
 *
 *   wat321_ask         - alias-driven dispatch (router resolves)
 *   wat321_session     - session lifecycle for opencode/local (action enum)
 *   wat321_bridge      - single-purpose inbox drain (Codex-gated)
 *
 *   bridge://instances         - catalog of configured backends
 *   bridge://sessions/{target} - session aliases per target
 *   bridge://inbox/codex       - pending Codex late replies (peek, not drain)
 *   bridge://status            - daemon health, last-used backend
 *   bridge://docs/dispatch     - dispatch reference (wait modes, routing)
 *   bridge://docs/inbox        - inbox reference (drain mechanics)
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
 * The router collapses target + instance routing into a single free-
 * form `alias` string ("Big Pickle", "Codex", "Local LLM") with fuzzy
 * matching against the catalog, so Claude doesn't need to know the
 * target enum or backend URLs exists. Adding a new instance is a
 * catalog edit; the router gets it for free. Tool descriptions name
 * the canonical-entry contract so agents don't reach for the
 * underlying CLIs directly. Total system-prompt overhead ~250-300
 * tokens with all three tools enabled.
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
import * as bridgeInbox from "./bridgeInbox.mjs";
import * as codex from "./codex.mjs";
import * as opencode from "./opencode/index.mjs";
import { WAT321_ROOT, bridgeStateDir, openCodeRoutesStateDir } from "./paths.mjs";
import { decorateAskResult } from "./replyDecorator.mjs";
import {
  filterEnabledResources,
  readResourceContent,
  resourceMimeType,
} from "./resources.mjs";

const BRIDGE_DIR = bridgeStateDir();
const CONFIG_PATH = join(BRIDGE_DIR, "config.json");
const OPENCODE_ROUTES_CONFIG_PATH = join(openCodeRoutesStateDir(), "config.json");
const LOG_PATH = join(BRIDGE_DIR, "channel.log");
const LOG_MAX_BYTES = 50_000;

/** Per-workspace sticky FF flag. Read here only to gate the
 * "sticky FF + non-Codex target" path; mirrors
 * `WAT321_EPIC_HANDSHAKE/constants.ts:fireAndForgetFlagPath(wsHash)`. */
const WAT321_WS_ID = process.env.WAT321_WORKSPACE_ID || "default";
const FIRE_AND_FORGET_FLAG_PATH = join(
  WAT321_ROOT,
  "epic-handshake",
  `fire-and-forget.${WAT321_WS_ID}.flag`
);

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
 * to Claude. Up to three tools:
 *
 *   wat321_ask     - dispatch a prompt; alias picks the backend
 *   wat321_session - opencode/local session lifecycle (action enum,
 *                    only registered when opencode or local is enabled)
 *   wat321_bridge  - single-purpose inbox drain (only registered when
 *                    codex is enabled)
 *
 * Read-only state (inbox peek, sessions list, instances catalog,
 * status, dispatch/inbox docs) lives on MCP resources (see resources/
 * list below) so Claude pays for those descriptions only when the
 * user asks. The unified router resolves alias strings to concrete
 * targets so Claude doesn't need to know the target enum exists.
 *
 * Total tool surface ~250-300 tokens when all three tools register. */
function buildTools(enabled) {
  const tools = [];
  const anyEnabled = enabled.codex || enabled.opencode || enabled.local;
  if (!anyEnabled) return tools;

  // Lean tool description. Carries the three load-bearing signals:
  //   1. Trigger phrase ("when user says ask/tell/prompt Codex").
  //   2. False-positive guard ("not for past references or hypotheticals").
  //   3. Required-read pointer to `bridge://docs/dispatch` for
  //      everything else (wait modes, alias rules, sticky-flag
  //      semantics, error recovery).
  // Per-param descriptions stripped - names are self-documenting and
  // the resource doc covers the non-obvious cases. The doc-deferral
  // pattern keeps the per-turn system-prompt tax lean: every prompt
  // pays the tool description; only the prompts that actually dispatch
  // pay for the dispatch doc when Claude calls ReadResource on it.
  tools.push({
    name: "wat321_ask",
    description:
      "Send a prompt to Codex, OpenCode, or Local LLM (or any configured alias like Big Pickle) via the WAT321 bridge. Use when the user says ask/tell/prompt one of those - not for past references or hypotheticals. Read `bridge://docs/dispatch` before your first dispatch.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        alias: { type: "string" },
        session: { type: "string" },
        thread_name: { type: "string" },
        timeout_sec: { type: "integer" },
        fire_and_forget: { type: "boolean" },
        adaptive: { type: "boolean" },
      },
      required: ["prompt"],
    },
  });

  // wat321_bridge: single-purpose drain tool. Drains pending late
  // replies from EVERY enabled backend's inbox - Codex (Epic Handshake
  // filesystem mailbox) plus any non-Codex target that received a
  // fire-and-forget dispatch this session. Registered whenever any
  // backend is enabled because every target can produce FF replies.
  tools.push({
    name: "wat321_bridge",
    description:
      "Drain pending fire-and-forget replies from the WAT321 bridge inbox (Codex + OpenCode + Local). Read `bridge://docs/inbox` before use.",
    inputSchema: {
      type: "object",
      properties: {
        reply_id: { type: "string" },
      },
    },
  });

  // Session mutations for opencode/local. Action enum self-documents
  // the three operations (create / delete / rename). Description
  // names WHY to use it (alias persistence across windows, avoid
  // orphan sessions) so AI callers don't try to manage sessions via
  // direct backend API calls.
  if (enabled.opencode || enabled.local) {
    const sessionTargets = [];
    if (enabled.opencode) sessionTargets.push("opencode");
    if (enabled.local) sessionTargets.push("local");
    tools.push({
      name: "wat321_session",
      description:
        "Create, delete, or rename a named session for OpenCode or Local LLM. Aliases (S1, S2, ...) persist across VS Code windows so a `wat321_ask` with `session: 'S2'` reaches the same conversation context as before. Use this instead of calling the backend HTTP API directly; the bridge tracks the alias map and routes future dispatches to the right server-side session. To list existing sessions, read `bridge://sessions/{target}` (resource, not this tool).",
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
//
// `instructions` is the always-on routing hint. Deferred MCP tools surface
// by name only, so wat321_ask's description is not in context until Claude
// searches for it. This server-level string is always present and steers
// "ask Codex / another model" to the bridge instead of a raw CLI (#80).
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
    // Resolve effective wait mode for the call. Per-call `true` wins,
    // per-call `false` suppresses the matching sticky flag for this
    // call only, otherwise the sticky flag on disk decides. Codex has
    // its own resolveMode in codex.mjs; for non-Codex we resolve here
    // because the wrapper has to choose between sync handleAsk vs the
    // detached FF path before calling into the target module.
    const explicitFFTrue = args?.fire_and_forget === true;
    const explicitFFFalse = args?.fire_and_forget === false;
    const stickyFFOn =
      !explicitFFFalse && existsSync(FIRE_AND_FORGET_FLAG_PATH);
    const effectiveFF = explicitFFTrue || stickyFFOn;

    // Adaptive is Codex-only - non-Codex backends have no progress
    // heartbeat for adaptive to extend against. Reject explicit
    // adaptive on a non-Codex target; sticky adaptive falls through to
    // sync silently (functionally identical, no error needed).
    if (args?.adaptive === true && target !== "codex") {
      return errorResult(
        `adaptive is only supported for target='codex'. The ${target} backend has no progress heartbeat for adaptive to extend against. Reissue the same prompt without the adaptive parameter and use timeout_sec if you need a longer fixed wait (this is not a dispatch failure; nothing was sent to ${target}).`
      );
    }

    // Forward to the existing handler with target + instance_id baked
    // back in. handleAsk's signature predates the router; rather than
    // refactor every call site we synthesize the legacy args shape.
    const forwardArgs = {
      ...args,
      target,
      ...(resolved.instance_id ? { instance_id: resolved.instance_id } : {}),
    };

    // Non-Codex fire-and-forget: write an outbound envelope to the
    // dispatch queue and return immediately. The extension-side
    // `OpenCodeDispatcher` (registered with the engine's
    // `OutboundWatcher`) picks up the envelope, runs the HTTP/SSE
    // call, and writes the inbound reply to
    // `<bridgeStateDir>/inbox/<target>/<id>.md`. `wat321_bridge()`
    // drains both Codex's Epic Handshake inbox and these per-target
    // inboxes in a single call. Codex FF stays on its own envelope-
    // based path inside codex.handleAsk.
    //
    // Lifecycle: the dispatcher lives in the extension host, not the
    // MCP runtime process, so an MCP-side restart no longer aborts
    // in-flight FF work. Graceful shutdown writes a synthetic
    // "cancelled by shutdown" inbound envelope for anything still
    // running when VS Code closes.
    if (effectiveFF && target !== "codex") {
      return bridgeInbox.dispatchFireAndForget(target, forwardArgs);
    }

    const askResult = await targetModule.handleAsk(forwardArgs);
    return decorateAskResult(askResult, args, target);
  }

  if (name === "wat321_bridge") {
    const anyEnabled =
      enabled.codex === true ||
      enabled.opencode === true ||
      enabled.local === true;
    if (!anyEnabled) {
      return errorResult(
        "wat321_bridge requires at least one backend to be enabled. Turn on Epic Handshake or OpenCode in WAT321 settings and reload."
      );
    }
    // Single-purpose drain across every per-target inbox. Codex
    // late-replies live in Epic Handshake's filesystem mailbox; non-
    // Codex FF replies live under the per-client bridge state dir.
    // Both contribute to the same drain so the agent doesn't have to
    // know which target produced which reply. handleBridge in codex.mjs
    // also validates a legacy `action: "consume"` field for callers
    // cached against the pre-collapse schema; anything else returns an
    // error WITHOUT side effects.
    return dispatchBridgeDrain(args, enabled);
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

/** Combine Codex (Epic Handshake) and non-Codex (per-target) inbox
 * drains into a single tool response. Both drain functions return
 * tool-response-shaped content. The combiner concatenates only the
 * non-empty drains; if both come back empty it emits a single unified
 * empty-state message instead of stacking per-source empty texts -
 * agents misread a mixed "no pending replies / here is your reply"
 * response as a partial failure even though the data was attached.
 *
 * `codex.handleBridge` signals empty via `{ content: [] }`. Errors
 * (e.g. unknown action, missing reply_id) come back with isError=true
 * and short-circuit the drain so the agent sees the original error
 * verbatim instead of "no pending replies" stapled to the failure. */
async function dispatchBridgeDrain(args, enabled) {
  const replyId =
    typeof args?.reply_id === "string" && args.reply_id.trim().length > 0
      ? args.reply_id.trim()
      : null;

  const sections = [];

  if (enabled.codex === true) {
    const codexResult = await codex.handleBridge(args);
    if (codexResult?.isError === true) return codexResult;
    const codexText = (codexResult?.content ?? [])
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n\n")
      .trim();
    if (codexText.length > 0) sections.push(codexText);
  }

  const nonCodex = await bridgeInbox.consumeNonCodexInbox(replyId);
  for (const item of nonCodex) {
    sections.push(
      `[${item.target} reply ${item.filename}]\n\n${item.content.trim()}`
    );
  }

  if (sections.length === 0) {
    // Surface in-flight non-Codex FF dispatches in the empty-state so
    // the agent can report "still working" honestly instead of hedging
    // "the reply may or may not be coming". Counting drives the report:
    // empty + nothing in flight = nothing to wait on; empty + N in flight
    // = the dispatches are running and the next drain will catch them.
    const inFlight = bridgeInbox.inFlightNonCodexSummary();
    if (inFlight.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "No pending replies in the bridge inbox, and no in-flight fire-and-forget dispatches detected. Nothing to wait on - if the user expected a reply, the dispatch may have never been queued (re-issue) or it already drained on a previous `wat321_bridge()` call.",
          },
        ],
      };
    }
    const lines = inFlight.map((d) => {
      const aliasPart = d.alias ? ` to ${d.alias}` : "";
      const previewPart = d.promptPreview ? ` "${d.promptPreview}"` : "";
      return `  - ${d.target}${aliasPart} (${d.ageSec}s ago, id=${d.id})${previewPart}`;
    });
    return {
      content: [
        {
          type: "text",
          text:
            `No replies have landed yet. ${inFlight.length} fire-and-forget dispatch${inFlight.length === 1 ? " is" : "es are"} still in flight:\n\n${lines.join("\n")}\n\n` +
            "Report this to the user as a wait, not a failure - the extension-side dispatcher is running. Call `wat321_bridge()` again when the user asks for the reply. Do not re-issue the same prompt; that would queue a duplicate dispatch.",
        },
      ],
    };
  }

  return {
    content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
  };
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
  `wat321 unified bridge MCP server connected (wsId=${process.env.WAT321_WORKSPACE_ID || "default"})`
);
