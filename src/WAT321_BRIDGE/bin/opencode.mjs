/**
 * OpenCode + Local LLM target handlers for the unified WAT321 bridge.
 *
 * Routes through the WAT321-managed `opencode serve` subprocess
 * (lifecycle in `src/WAT321_MODEL_BRIDGE/openCodeManager.ts`).
 * Sessions are owned by OpenCode itself - stored in
 * `~/.local/share/opencode/opencode.db` - and accessed via the REST
 * API verified during the v1.4.1 investigation:
 *
 *   GET  /session                -> list all sessions
 *   POST /session                -> create new session, returns {id, slug, ...}
 *   POST /session/{id}/message   -> send prompt, blocks until completion
 *   GET  /event                  -> SSE stream of session events
 *
 * Anonymous tier: opencode.ai/zen/v1/chat/completions accepts
 * unauthenticated requests for one-shots when no session is needed.
 *
 * Status: minimal v1 port. Covers session create/list/resume +
 * resumable ask + one-shot anonymous fallback. Phased gating, async
 * inbox, agent param, dir param, and the OpenCode harness sub-agent
 * loop are intentionally out of scope per
 * WDDOCS/WAT321_V141_MB_FEATURE_STRIP.md.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BRIDGE_DIR = join(homedir(), ".wat321", "bridge");
const ALIAS_PATH = join(BRIDGE_DIR, "session-aliases.json");
const MB_CONFIG_PATH = join(homedir(), ".wat321", "model-bridge", "config.json");

const ANON_BASE_URL = "https://opencode.ai/zen/v1";
const DEFAULT_TIMEOUT_SEC = 120;

function ensureDir() {
  if (!existsSync(BRIDGE_DIR)) mkdirSync(BRIDGE_DIR, { recursive: true });
}

function readAliases() {
  ensureDir();
  if (!existsSync(ALIAS_PATH)) return { opencode: {}, local: {} };
  try {
    const parsed = JSON.parse(readFileSync(ALIAS_PATH, "utf8"));
    return {
      opencode:
        parsed && typeof parsed.opencode === "object" ? parsed.opencode : {},
      local: parsed && typeof parsed.local === "object" ? parsed.local : {},
    };
  } catch {
    return { opencode: {}, local: {} };
  }
}

function writeAliases(map) {
  // Atomic tmp+rename so a crash mid-write cannot leave the alias
  // file half-formed. Single-writer usage (only this MCP server
  // process writes), so no inter-process coordination needed.
  ensureDir();
  const tmp = `${ALIAS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2));
  renameSync(tmp, ALIAS_PATH);
}

/** Pick the next free S<n> alias for a target. Counts existing
 * aliases, returns "S<n+1>". */
function nextAlias(target) {
  const map = readAliases();
  const taken = Object.keys(map[target] || {});
  let n = 1;
  while (taken.includes(`S${n}`)) n++;
  return `S${n}`;
}

/** Read the WAT321-managed opencode serve URL from MB's channel
 * config. Returns null when MB is disabled or the subprocess hasn't
 * spawned yet. */
function readServeUrl() {
  if (!existsSync(MB_CONFIG_PATH)) return null;
  try {
    const cfg = JSON.parse(readFileSync(MB_CONFIG_PATH, "utf8"));
    const url = cfg?.openCodeServerUrl;
    return typeof url === "string" && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/** Read the configured instance catalog (model id, kind, retention)
 * from MB's channel config. */
function readInstances() {
  if (!existsSync(MB_CONFIG_PATH)) return [];
  try {
    const cfg = JSON.parse(readFileSync(MB_CONFIG_PATH, "utf8"));
    return Array.isArray(cfg?.instances) ? cfg.instances : [];
  } catch {
    return [];
  }
}

function findInstance(id) {
  const instances = readInstances();
  if (!id) {
    // Read MB config for the click-menu's active instance; fall back
    // to the first remote (cloud) instance if no active is set; final
    // fallback is null (caller decides whether that is acceptable).
    if (!existsSync(MB_CONFIG_PATH)) return null;
    try {
      const cfg = JSON.parse(readFileSync(MB_CONFIG_PATH, "utf8"));
      const activeId = typeof cfg?.activeInstanceId === "string" ? cfg.activeInstanceId : null;
      if (activeId) {
        const active = instances.find((i) => i.id === activeId);
        if (active) return active;
      }
      return instances.find((i) => i.kind === "remote") || null;
    } catch {
      return null;
    }
  }
  return instances.find((i) => i.id === id) || null;
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

/** POST a chat completion to opencode.ai's anonymous Zen endpoint.
 * Used for one-shot calls where no session is needed. No auth header. */
async function anonymousChatCompletion(model, prompt, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ANON_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4096,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, error: `Zen API returned ${res.status}: ${await res.text().catch(() => "")}` };
    }
    const data = await res.json();
    const choice = data?.choices?.[0]?.message;
    const content = choice?.content || "";
    const reasoning = choice?.reasoning_content || "";
    const text = content.length > 0 ? content : reasoning;
    const actualModel = data?.model || model;
    return { ok: true, text, actualModel, cost: data?.cost ?? null };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Fetch the latest assistant message from a session without sending
 * anything new. Used by the empty-prompt + session retrieval path
 * (handleAsk) and as the implementation backing handleInbox's
 * "fetch latest" hint. */
async function retrieveLatestSessionMessage(target, sessionAlias) {
  const map = readAliases();
  const sessionId = map[target]?.[sessionAlias];
  if (!sessionId) {
    return errorResult(
      `Session alias '${sessionAlias}' not found for target=${target}.`
    );
  }
  const serveUrl = readServeUrl();
  if (serveUrl === null) {
    return errorResult(
      "opencode serve is not running. Enable Model Bridge in WAT321 settings."
    );
  }
  try {
    const res = await fetch(`${serveUrl}/session/${sessionId}/message`);
    if (!res.ok) {
      return errorResult(
        `Could not fetch session messages: opencode serve returned ${res.status}.`
      );
    }
    const messages = await res.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Session ${sessionAlias} has no messages yet.`,
          },
        ],
      };
    }
    const latest = messages[messages.length - 1];
    const parts = Array.isArray(latest?.parts) ? latest.parts : [];
    const text = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n\n");
    if (!text) {
      return {
        content: [
          {
            type: "text",
            text: `Session ${sessionAlias} latest message has no text parts (role=${latest?.info?.role ?? "?"}).`,
          },
        ],
      };
    }
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return errorResult(
      `Session message fetch failed: ${err?.message || String(err)}`
    );
  }
}

/** POST a message to a managed opencode serve session. */
async function postSessionMessage(serveUrl, sessionId, prompt, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${serveUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, error: `opencode serve returned ${res.status}: ${await res.text().catch(() => "")}` };
    }
    const data = await res.json();
    // OpenCode session messages return a structured message object;
    // the assistant text is in parts[].text fields. Concatenate.
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

/** Handle `wat321_ask({target: "opencode" | "local", ...})`. Empty
 * prompt + session = retrieve the session's latest assistant message
 * without sending anything new. This is the "inbox" pattern that
 * handleInbox refers users to. */
export async function handleAsk(args) {
  const target = args?.target;
  const prompt = typeof args?.prompt === "string" ? args.prompt : "";
  const sessionAlias = typeof args?.session === "string" ? args.session : null;
  if (prompt.trim().length === 0) {
    if (sessionAlias === null) {
      return errorResult(
        `Expected a non-empty 'prompt' argument for target=${target}. (Empty prompt is only valid with session=<alias> for retrieving the latest assistant message.)`
      );
    }
    return retrieveLatestSessionMessage(target, sessionAlias);
  }

  const timeoutSec =
    typeof args?.timeout_sec === "number" && Number.isFinite(args.timeout_sec)
      ? args.timeout_sec
      : DEFAULT_TIMEOUT_SEC;
  const timeoutMs = Math.max(5_000, timeoutSec * 1000);

  const instanceId = typeof args?.instance_id === "string" ? args.instance_id : null;

  // Session-attached path: lookup alias, POST to /session/{id}/message.
  if (sessionAlias !== null) {
    const map = readAliases();
    const sessionId = map[target]?.[sessionAlias];
    if (!sessionId) {
      return errorResult(
        `Session alias '${sessionAlias}' not found for target=${target}. Create it first via wat321_session({target:'${target}', action:'create'}).`
      );
    }
    const serveUrl = readServeUrl();
    if (serveUrl === null) {
      return errorResult(
        `opencode serve is not running. Enable Model Bridge in WAT321 settings, then retry.`
      );
    }
    const result = await postSessionMessage(serveUrl, sessionId, prompt, timeoutMs);
    if (!result.ok) {
      return errorResult(`Session dispatch failed: ${result.error}`);
    }
    return { content: [{ type: "text", text: result.text }] };
  }

  // One-shot path. For target=opencode, fall back to the anonymous
  // Zen big-pickle slug when no instance is resolved. For target=local,
  // refuse to fall through - local catalog entries have a blank model
  // field by design (llama.cpp ignores the request's model and answers
  // with whatever is loaded), so a missing instance + blank model
  // would silently route to anonymous Big Pickle, which is a routing
  // bug. Require an opencode session for local one-shots, or a
  // configured local catalog entry.
  const instance = findInstance(instanceId);
  if (target === "local") {
    if (!instance) {
      return errorResult(
        "target=local requires a resumable session. Create one with wat321_session({target:'local', action:'create'}) and pass session=alias on wat321_ask."
      );
    }
    return errorResult(
      "target=local one-shot dispatch is not supported (llama.cpp model ids are server-side). Use wat321_session to create a local session, then wat321_ask({target:'local', session:'S1', prompt:'...'})."
    );
  }
  const modelSlug = instance?.model || "big-pickle";
  const result = await anonymousChatCompletion(modelSlug, prompt, timeoutMs);
  if (!result.ok) {
    return errorResult(`One-shot dispatch failed: ${result.error}`);
  }
  let text = result.text;
  if (result.actualModel && result.actualModel !== modelSlug) {
    text += `\n\n[routed via ${result.actualModel}; cost: ${result.cost ?? "?"}]`;
  }
  return { content: [{ type: "text", text }] };
}

/** Handle `wat321_inbox({target: "opencode" | "local", ...})`. With no
 * session arg, returns a message explaining that opencode/local don't
 * use the late-reply inbox pattern - the user should pass a session
 * id to fetch its latest assistant message. */
export async function handleInbox(args) {
  const target = args?.target;
  const sessionAlias = typeof args?.session === "string" ? args.session : null;
  if (sessionAlias === null) {
    return {
      content: [
        {
          type: "text",
          text: `target=${target} doesn't queue late replies the way Codex does. Pass session=<alias> to fetch the latest assistant message from a specific session, or use wat321_session({action:'list'}) to see active sessions.`,
        },
      ],
    };
  }
  const map = readAliases();
  const sessionId = map[target]?.[sessionAlias];
  if (!sessionId) {
    return errorResult(
      `Session alias '${sessionAlias}' not found for target=${target}.`
    );
  }
  return {
    content: [
      {
        type: "text",
        text: `Session ${sessionAlias} (${sessionId}) latest-message fetch not yet ported. Use wat321_ask({session:'${sessionAlias}', prompt:''}) as a workaround - empty prompt re-emits the session's latest assistant turn.`,
      },
    ],
  };
}

/** Handle `wat321_list({target: "opencode" | "local"})`. Returns the
 * MB instance catalog filtered by kind. */
export async function handleList(args) {
  const target = args?.target;
  const instances = readInstances();
  const filtered = instances.filter((i) => {
    if (target === "local") return i.kind === "local";
    if (target === "opencode") return i.kind === "remote";
    return true;
  });
  if (filtered.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No instances configured for target=${target}.`,
        },
      ],
    };
  }
  const lines = filtered.map((i) => {
    const status = i.apiKeyMissing ? "needs API key" : "ready";
    return `- ${i.id} (${i.alias}) - kind=${i.kind} model=${i.model || "(auto)"} retention=${i.dataRetention} ${status}`;
  });
  return {
    content: [
      {
        type: "text",
        text: `Configured instances for target=${target}:\n\n${lines.join("\n")}`,
      },
    ],
  };
}

/** Handle `wat321_session({target, action, ...})`. */
export async function handleSession(args) {
  const target = args?.target;
  const action = args?.action;
  const map = readAliases();

  if (action === "list") {
    const aliases = map[target] || {};
    const entries = Object.entries(aliases);
    if (entries.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No sessions for target=${target}. Create one via wat321_session({target:'${target}', action:'create'}).`,
          },
        ],
      };
    }
    const lines = entries.map(([alias, id]) => `- ${alias}: ${id}`);
    return {
      content: [
        { type: "text", text: `Sessions for target=${target}:\n\n${lines.join("\n")}` },
      ],
    };
  }

  if (action === "create") {
    const serveUrl = readServeUrl();
    if (serveUrl === null) {
      return errorResult(
        "opencode serve is not running. Enable Model Bridge in WAT321 settings."
      );
    }
    // Bind the session to a specific model on create so it shows up
    // in opencode's session list with the right model metadata
    // (matches what `opencode` interactive mode does when the user
    // picks Big Pickle and types). Without this binding, the session
    // is created model-less and OpenCode's default kicks in only
    // when the first message arrives - the session list shows
    // "model: undefined" which looks broken.
    const instanceId = typeof args?.instance_id === "string" ? args.instance_id : null;
    const instance = findInstance(instanceId);
    const body = {};
    if (instance?.model) {
      body.model = {
        id: instance.model,
        providerID: instance.harnessProviderID || "zen",
      };
    }
    try {
      const res = await fetch(`${serveUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        return errorResult(`opencode serve returned ${res.status} on /session create.`);
      }
      const data = await res.json();
      const sessionId = data?.id;
      if (!sessionId) return errorResult("opencode serve /session create did not return an id.");
      const alias = nextAlias(target);
      map[target] = map[target] || {};
      map[target][alias] = sessionId;
      writeAliases(map);
      const modelLabel = instance?.alias || data?.model?.id || "default model";
      return {
        content: [
          {
            type: "text",
            text: `Created session ${alias} (${modelLabel}) -> ${sessionId} (slug: ${data?.slug || "?"}). Use wat321_ask({target:'${target}', session:'${alias}', prompt:'...'}) to dispatch.`,
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
      const sessionId = map[target][alias];
      delete map[target][alias];
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
    // rename
    const newName = typeof args?.new_name === "string" ? args.new_name : null;
    if (newName === null) {
      return errorResult("Rename requires a 'new_name' argument.");
    }
    if (map[target][newName]) {
      return errorResult(`Alias '${newName}' is already in use.`);
    }
    map[target][newName] = map[target][alias];
    delete map[target][alias];
    writeAliases(map);
    return {
      content: [{ type: "text", text: `Renamed ${alias} -> ${newName}.` }],
    };
  }

  if (action === "resume") {
    // Resume is implicit: just validate the alias exists.
    const alias = typeof args?.session === "string" ? args.session : null;
    if (alias === null) return errorResult("Resume requires a 'session' argument.");
    if (!map[target]?.[alias]) {
      return errorResult(`Session alias '${alias}' not found for target=${target}.`);
    }
    return {
      content: [
        {
          type: "text",
          text: `Session ${alias} ready. Use wat321_ask({target:'${target}', session:'${alias}', prompt:'...'}) to send a message.`,
        },
      ],
    };
  }

  return errorResult(`Unknown action '${action}'. Expected list, create, resume, delete, or rename.`);
}
