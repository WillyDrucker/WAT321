#!/usr/bin/env node
/**
 * WAT321 Model Bridge - MCP server.
 *
 * Registered via `claude mcp add wat321-model-bridge -- node <path>`.
 * Tool surface:
 *
 *   model_bridge_ask({prompt, instance_id?, system?, async?})   - one-shot
 *   model_bridge_inbox({requestId?, peek?})                     - drain async
 *   model_bridge_thread({action, instance_id?, thread_id?, ...}) - multi-turn
 *   model_bridge_task({prompt, instance_id?, ...})              - tool-using
 *   model_bridge_list({})                                       - inventory
 *
 * `model_bridge_ask` streams an OpenAI-compatible chat completion via
 * SSE, surfaces a phase trace if the Phased Model Protocol is
 * enabled, and either returns the reply (sync) or deposits it in the
 * inbox (async). Routes to the instance the caller names, falling
 * back to the click-menu's active instance.
 *
 * `model_bridge_thread` adds Codex/Claude-style persistent
 * conversations: each thread keeps a rollout.jsonl, replays history
 * per turn so llama.cpp's prefix cache hits, auto-compacts when the
 * rollout passes a configurable fraction of n_ctx, and exposes
 * start/ask/list/end/compact/resume sub-actions. Each thread is
 * pinned to its starting instance.
 *
 * Settings flow: extension host writes ~/.wat321/model-bridge/config.json
 * atomically on every settings change. Read per call so settings
 * changes take effect immediately, no restart.
 *
 * Heartbeat: a single JSON file the status-bar widget polls. Updated
 * at most once per HEARTBEAT_THROTTLE_MS during streaming, plus on
 * every phase transition. Cleared on completion / failure.
 */

import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, setGlobalDispatcher } from "undici";

// Default Node 22 fetch caps headers + body timeouts at 5 minutes.
// OpenCode tool loops can run longer than that (Gemma E4B at Q8
// driving multi-step tasks regularly hits 5-10 minutes). The bridge
// already enforces its own AbortController-driven ceiling per task,
// so we lift undici's defaults out of the way and let our timer be
// the only timeout. connectTimeout stays tight - if a TCP connect
// can't complete in 10s, the server is genuinely unreachable.
setGlobalDispatcher(
  new Agent({
    connectTimeout: 10_000,
    headersTimeout: 0,
    bodyTimeout: 0,
  })
);

const MB_DIR = join(homedir(), ".wat321", "model-bridge");
const CONFIG_PATH = join(MB_DIR, "config.json");
const LOG_PATH = join(MB_DIR, "channel.log");
const HEARTBEAT_PATH = join(MB_DIR, "heartbeat.json");
const INBOX_DIR = join(MB_DIR, "inbox");
const SESSIONS_DIR = join(MB_DIR, "sessions");
const USAGE_PATH = join(MB_DIR, "usage.json");
const LOG_MAX_BYTES = 50_000;
const HEARTBEAT_THROTTLE_MS = 250;
const INBOX_TTL_MS = 60 * 60 * 1000;
/** Default n_ctx assumption when /props probe fails. Conservative -
 * Gemma 3 E4B native is 131072 but most launchers run 32K-64K to
 * stay in VRAM. Auto-compact percentages remain meaningful when this
 * value is wrong; they are just less precise. */
const DEFAULT_N_CTX_FALLBACK = 32_768;

if (!existsSync(MB_DIR)) mkdirSync(MB_DIR, { recursive: true });
if (!existsSync(INBOX_DIR)) mkdirSync(INBOX_DIR, { recursive: true });
if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });

let busyRequest = null;

// ----------------------------------------------------------------------
// log + atomic write
// ----------------------------------------------------------------------

function rotateLogIfNeeded() {
  try {
    if (!existsSync(LOG_PATH)) return;
    const st = statSync(LOG_PATH);
    if (st.size < LOG_MAX_BYTES) return;
    renameSync(LOG_PATH, `${LOG_PATH}.old`);
  } catch {
    // best-effort
  }
}

function log(level, msg) {
  try {
    rotateLogIfNeeded();
    const stamp = new Date().toISOString();
    writeFileSync(LOG_PATH, `${stamp} [${level}] ${msg}\n`, { flag: "a" });
  } catch {
    // best-effort
  }
}

function writeJsonAtomic(targetPath, payload) {
  try {
    // Reset WAT321 wipes ~/.wat321/, and a sibling Claude session
    // calling from a never-before-seen workspace can hit a missing
    // subdir on first write. Defensive recreate - cheap and always
    // safe within our own dir tree.
    const dir = join(targetPath, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${targetPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`);
    renameSync(tmp, targetPath);
    return true;
  } catch (err) {
    log("warn", `atomic write failed for ${targetPath}: ${err?.message || String(err)}`);
    return false;
  }
}

function writeHeartbeat(payload) {
  writeJsonAtomic(HEARTBEAT_PATH, payload);
}

function clearHeartbeat() {
  try {
    if (existsSync(HEARTBEAT_PATH)) unlinkSync(HEARTBEAT_PATH);
  } catch {
    // best-effort
  }
}

// ----------------------------------------------------------------------
// session usage counters
// ----------------------------------------------------------------------

/** Read the per-instance cumulative usage file. Returns a default
 * shape on missing / torn file so callers can always merge into a
 * known-good object. */
function readUsage() {
  if (!existsSync(USAGE_PATH)) {
    return { sinceMs: Date.now(), instances: {} };
  }
  try {
    const raw = readFileSync(USAGE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      sinceMs: typeof parsed?.sinceMs === "number" ? parsed.sinceMs : Date.now(),
      instances: parsed?.instances && typeof parsed.instances === "object" ? parsed.instances : {},
    };
  } catch {
    return { sinceMs: Date.now(), instances: {} };
  }
}

/** Append a successful call's token deltas to the persistent usage
 * file. Atomic merge - reads, mutates, writes via a tmp+rename so
 * the widget's polling reader never sees a torn entry.
 *
 * `prompt` and `completion` come from the OpenAI-compat usage block
 * the server returns; either may be missing if the server omits the
 * field, in which case we treat as 0 for the corresponding side. */
function recordUsage(instanceId, prompt, completion) {
  if (!instanceId) return;
  const data = readUsage();
  const existing = data.instances[instanceId] ?? { input: 0, output: 0, calls: 0, lastTs: "" };
  existing.input += typeof prompt === "number" ? prompt : 0;
  existing.output += typeof completion === "number" ? completion : 0;
  existing.calls += 1;
  existing.lastTs = new Date().toISOString();
  data.instances[instanceId] = existing;
  writeJsonAtomic(USAGE_PATH, data);
}

// ----------------------------------------------------------------------
// config
// ----------------------------------------------------------------------

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    log("warn", `config read failed: ${err?.message || String(err)}`);
    return null;
  }
}

/** Resolve which instance handles a tool call. Honors an explicit
 * `instance_id` arg first, then falls back to the active id chosen by
 * the click menu. Returns `{instance, error}`; the caller should
 * surface `error` to Claude and abort when present. */
function pickInstance(config, requestedId) {
  const instances = Array.isArray(config?.instances) ? config.instances : [];
  if (instances.length === 0) {
    return {
      instance: null,
      error:
        "Model Bridge config is empty. Toggle wat321.modelBridge.enabled in VS Code settings, then reconnect MCP (/mcp) so the bridge picks up the catalog.",
    };
  }

  const target =
    typeof requestedId === "string" && requestedId.length > 0
      ? requestedId
      : config.activeInstanceId;

  if (!target) {
    const allIds = instances.map((i) => i.id).join(", ");
    return {
      instance: null,
      error: `No active Model Bridge instance selected. Available: ${allIds}. Pass instance_id explicitly or pick one via the WAT321 status bar click menu -> Active Instance.`,
    };
  }

  const found = instances.find((i) => i.id === target);
  if (!found) {
    const allIds = instances.map((i) => i.id).join(", ");
    return {
      instance: null,
      error: `Unknown instance_id '${target}'. Configured instances: ${allIds}.`,
    };
  }
  if (found.kind === "remote" && found.apiKeyMissing) {
    return {
      instance: null,
      error: `Instance '${target}' (${found.alias}) needs an API key. Run the command 'WAT321: Model Bridge - Set OpenCode Zen API Key' (or click the Model Bridge widget -> Set Zen API Key).`,
    };
  }
  return { instance: found, error: null };
}

function buildRequestBody(instance, config, messages) {
  const body = {
    messages,
    temperature: typeof config.temperature === "number" ? config.temperature : 0.2,
    max_tokens: typeof config.maxTokens === "number" ? config.maxTokens : 2000,
    stream: true,
  };
  if (typeof instance.model === "string" && instance.model.length > 0) {
    body.model = instance.model;
  }
  return body;
}

function buildAuthHeaders(instance) {
  const headers = { "Content-Type": "application/json" };
  if (instance.kind === "remote" && instance.apiKey) {
    headers.Authorization = `Bearer ${instance.apiKey}`;
  }
  return headers;
}

/** Per-instance retention banner. Surfaced loudly so a user routing
 * something sensitive to a `retained` instance sees the policy on
 * every tool reply. */
function retentionBanner(instance) {
  return instance.dataRetention === "retained"
    ? `[retention] ${instance.alias} may log or train on your prompts.`
    : `[retention] ${instance.alias} stays local.`;
}

/** Unwrap Node 22 undici's `TypeError: fetch failed` to surface the
 * underlying cause (ECONNREFUSED / ETIMEDOUT / EAI_NODATA / proxy
 * misconfig / TLS error / etc). The default `err.message` is just
 * `"fetch failed"` which tells us nothing - the real reason lives on
 * `err.cause`. Emits `<top> | cause: <code>: <cause-message>` for the
 * log so a user submitting a bug report has something diagnosable. */
function describeUndiciFetchError(err) {
  if (!err) return "(no error)";
  const top = err.message || String(err);
  const cause = err.cause;
  if (!cause) return top;
  const causeMsg = cause.message || String(cause);
  const code = cause.code ? `${cause.code}: ` : "";
  const errno = cause.errno !== undefined ? ` errno=${cause.errno}` : "";
  return `${top} | cause: ${code}${causeMsg}${errno}`;
}

function describeFetchError(err) {
  const msg = err?.message || String(err);
  if (err?.name === "AbortError") {
    return "Model Bridge call took longer than the configured timeout. Try a shorter prompt or raise the timeout via the click menu -> Configure -> Timeout.";
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET/i.test(msg)) {
    return "Model Bridge endpoint is unreachable. Check that the server is running and that the instance entry in wat321.modelBridge.instances has the right URL.";
  }
  return `Model Bridge request failed: ${msg}`;
}

function describeHttpError(status, bodyText) {
  if (status === 401 || status === 403) {
    return "Model Bridge endpoint rejected the request (auth). For cloud instances, run 'WAT321: Model Bridge - Set OpenCode Zen API Key'. For local instances, check the endpoint configuration.";
  }
  if (status === 429) {
    return "Model Bridge endpoint is rate-limiting requests. Try again in a moment.";
  }
  if (status === 503) {
    return "Model Bridge endpoint is loading the model or is otherwise unavailable. Try again shortly.";
  }
  const snippet = (bodyText || "").slice(0, 400);
  return `Model Bridge endpoint returned HTTP ${status}: ${snippet}`;
}

function resolveAlias(instance, payloadModel) {
  if (instance && typeof instance.alias === "string" && instance.alias.length > 0) {
    return instance.alias;
  }
  if (typeof payloadModel === "string" && payloadModel.length > 0) return payloadModel;
  if (instance && typeof instance.model === "string" && instance.model.length > 0) {
    return instance.model;
  }
  return "(model bridge)";
}

// ----------------------------------------------------------------------
// phase markers (Phased Model Protocol v1)
// ----------------------------------------------------------------------

/** Marker prompt prepended to every user envelope when phasedProtocol
 * is `markers-v1`. Lifted verbatim from Part III of the master plan. */
const MARKER_PROMPT_PREFIX =
  "You are responding inside the WAT321 Model Bridge. Your normal reply " +
  "follows the user's request below the divider. Additionally, emit short " +
  "marker tokens on a line by themselves so the bridge can show progress:\n\n" +
  "  - When you have understood the request and are about to begin work, " +
  "emit: <<PHASE:STARTED>>\n" +
  "  - When you have a working plan AND are about half done with the work " +
  "(or, for itemized tasks, after roughly N/2 items), emit:\n" +
  "    <<PHASE:HALFWAY:summary=\"brief description of what you've done so far\">>\n" +
  "  - When you are about to write the final answer body, emit: " +
  "<<PHASE:COMPLETING>>\n\n" +
  "Markers must be alone on their line, no prose around them. They are " +
  "meta-signals to the bridge, not addressed to the user, and should not " +
  "be explained. If the request is too small for a marker to apply, skip " +
  "it - the bridge has fallbacks. Do not invent additional markers.\n\n" +
  "---\n";

const MARKER_LINE_REGEX =
  /^\s*<<PHASE:(STARTED|HALFWAY|COMPLETING)(?::([^>]*))?>>\s*$/i;

/** Strip phase markers from a freshly-arrived delta of streamed text.
 * Returns `{cleaned, markers[]}`. Markers found mid-token (rare with
 * llama.cpp's per-token streaming but possible) are preserved by the
 * line-based check below - we only treat a marker as fired once we
 * see a complete line containing it.
 *
 * The streaming loop keeps a small "tail" buffer that may contain a
 * partially-arrived marker; we only scan complete lines (everything
 * before the last `\n`). The trailing partial line goes back into the
 * tail for the next chunk to complete. */
function extractMarkersFromBuffer(buffer) {
  const lines = buffer.split("\n");
  // Last element may be a partial line - hold it back.
  const partial = lines.pop() ?? "";
  const out = [];
  const markers = [];
  for (const line of lines) {
    const m = line.match(MARKER_LINE_REGEX);
    if (!m) {
      out.push(line);
      continue;
    }
    const phase = m[1].toUpperCase();
    const rest = (m[2] || "").trim();
    let summary = "";
    const summaryMatch = rest.match(/summary\s*=\s*"([^"]*)"/i);
    if (summaryMatch) summary = summaryMatch[1];
    markers.push({ phase, summary });
  }
  return {
    cleaned: out.length > 0 ? `${out.join("\n")}\n` : "",
    partial,
    markers,
  };
}

/** Format a phase trace block for inclusion at the top of a reply. */
function formatPhaseTrace(trace) {
  if (!trace || trace.length === 0) return "";
  const rows = trace.map((p) => {
    const elapsed =
      typeof p.elapsedMs === "number" ? `${(p.elapsedMs / 1000).toFixed(1)}s` : "?";
    const summary = p.summary ? ` - ${p.summary}` : "";
    return `  ${p.phase.padEnd(11)} ${elapsed}${summary}`;
  });
  return `[phase trace]\n${rows.join("\n")}\n`;
}

// ----------------------------------------------------------------------
// reply formatting
// ----------------------------------------------------------------------

function buildReplyMessage({ alias, model, elapsedMs, content, reasoning, usage, phaseTrace }) {
  const sections = [];
  const tracePart = formatPhaseTrace(phaseTrace);
  if (tracePart) sections.push(tracePart.trim());
  if (content.length > 0) sections.push(content);
  if (reasoning.length > 0) sections.push(`[reasoning]\n${reasoning}`);
  const reply =
    sections.length > 0
      ? sections.join("\n\n")
      : "(model returned no content; check ~/.wat321/model-bridge/channel.log for details)";

  const usageBits = [];
  if (typeof usage?.prompt_tokens === "number") usageBits.push(`prompt ${usage.prompt_tokens}`);
  if (typeof usage?.completion_tokens === "number") usageBits.push(`completion ${usage.completion_tokens}`);
  const usageSummary = usageBits.length > 0 ? `, ${usageBits.join(", ")}` : "";
  // Local-model self-introspection ("what model are you?") is
  // unreliable - llama.cpp loads a gguf and the model itself doesn't
  // know its own filename. Surfacing the server-reported model id in
  // the header lets the operator see what's loaded without asking
  // the model to introspect.
  const modelTag = typeof model === "string" && model.length > 0 ? ` · ${model}` : "";
  const header = `--- ${alias}${modelTag} reply (${elapsedMs} ms${usageSummary}) ---`;
  return `${header}\n\n${reply}`;
}

// ----------------------------------------------------------------------
// streaming core
// ----------------------------------------------------------------------

/** Stream a chat completion via SSE. Calls `onProgress` after every
 * token-bearing chunk and `onPhase` whenever a marker fires so the
 * caller can update heartbeat / phase state. Returns the assembled
 * reply or a structured failure on HTTP / fetch error. */
async function streamCompletion({ url, headers, body, signal, onProgress, onPhase, parseMarkers }) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    return { ok: false, kind: "fetch", err };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { ok: false, kind: "http", status: response.status, bodyText: text };
  }

  let content = "";
  let reasoning = "";
  // Tail buffers carry partial trailing lines across SSE chunks so
  // marker detection (which is line-based) does not split a marker.
  let contentTail = "";
  let reasoningTail = "";
  let finalUsage = {};
  let finalModel = "";
  let tokenCount = 0;
  let firstChunkSeen = false;

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) break;
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const dataPart = line.slice(5).trim();
        if (dataPart === "" || dataPart === "[DONE]") continue;
        let parsed;
        try {
          parsed = JSON.parse(dataPart);
        } catch {
          continue;
        }
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          onPhase?.({ phase: "RECEIPT" });
        }
        const choice = parsed?.choices?.[0];
        const delta = choice?.delta;
        if (delta) {
          if (typeof delta.content === "string" && delta.content.length > 0) {
            tokenCount++;
            if (parseMarkers) {
              contentTail += delta.content;
              const { cleaned, partial, markers } =
                extractMarkersFromBuffer(contentTail);
              contentTail = partial;
              if (cleaned) content += cleaned;
              for (const m of markers) onPhase?.(m);
            } else {
              content += delta.content;
            }
          }
          if (
            typeof delta.reasoning_content === "string" &&
            delta.reasoning_content.length > 0
          ) {
            tokenCount++;
            if (parseMarkers) {
              reasoningTail += delta.reasoning_content;
              const { cleaned, partial, markers } =
                extractMarkersFromBuffer(reasoningTail);
              reasoningTail = partial;
              if (cleaned) reasoning += cleaned;
              for (const m of markers) onPhase?.(m);
            } else {
              reasoning += delta.reasoning_content;
            }
          }
        }
        if (parsed?.usage) finalUsage = parsed.usage;
        if (typeof parsed?.model === "string" && parsed.model.length > 0) {
          finalModel = parsed.model;
        }
        onProgress({ tokenCount });
      }
    }
  }

  // Drain any partial tail that never got terminated by a newline -
  // llama.cpp usually ends the stream cleanly but defend anyway.
  if (contentTail.length > 0) content += contentTail;
  if (reasoningTail.length > 0) reasoning += reasoningTail;

  return {
    ok: true,
    content,
    reasoning,
    usage: finalUsage,
    model: finalModel,
    tokenCount,
  };
}

/** Drive a streaming call from start to finish. Owns the heartbeat
 * file, the busy gate, and (when phasedProtocol is `markers-v1`) the
 * phase trace assembly. Returns `{isError, message, meta}`. */
async function runStreamingCall({ requestId, instance, config, messages }) {
  const body = buildRequestBody(instance, config, messages);
  const headers = buildAuthHeaders(instance);
  const url = `${instance.endpoint.replace(/\/+$/, "")}/v1/chat/completions`;

  const timeoutMs =
    (typeof config.timeoutSec === "number" ? config.timeoutSec : 120) * 1000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  const start = Date.now();
  const aliasIdle = resolveAlias(instance, "");
  const phaseTrace = [{ phase: "DISPATCH", elapsedMs: 0 }];
  let currentPhase = "DISPATCH";
  let lastHeartbeatAt = 0;

  busyRequest = requestId;
  const writeBeat = (tokenCount) => {
    const now = Date.now();
    const elapsedMs = now - start;
    const elapsedSec = Math.max(0.001, elapsedMs / 1000);
    writeHeartbeat({
      phase: "calling",
      requestId,
      startedAt: new Date(start).toISOString(),
      alias: aliasIdle,
      instanceId: instance.id,
      dataRetention: instance.dataRetention,
      model: typeof instance.model === "string" ? instance.model : "",
      timeoutMs,
      tokens: tokenCount,
      tokensPerSec: Math.round(tokenCount / elapsedSec),
      currentPhase,
      phaseTrace,
    });
  };
  writeBeat(0);

  const handlePhase = (m) => {
    const elapsedMs = Date.now() - start;
    const entry = { phase: m.phase, elapsedMs };
    if (m.summary) entry.summary = m.summary;
    phaseTrace.push(entry);
    currentPhase = m.phase;
    // Phase transitions are sparse and worth a write even mid-throttle.
    lastHeartbeatAt = Date.now();
    writeBeat(undefined);
  };

  try {
    const result = await streamCompletion({
      url,
      headers,
      body,
      signal: ac.signal,
      parseMarkers: config.phasedProtocol === "markers-v1",
      onPhase: handlePhase,
      onProgress: ({ tokenCount }) => {
        const now = Date.now();
        if (now - lastHeartbeatAt < HEARTBEAT_THROTTLE_MS) return;
        lastHeartbeatAt = now;
        writeBeat(tokenCount);
      },
    });
    clearTimeout(timer);

    if (!result.ok && result.kind === "fetch") {
      const message = describeFetchError(result.err);
      log("error", `${url} -> ${message}`);
      return { isError: true, message };
    }
    if (!result.ok && result.kind === "http") {
      const message = describeHttpError(result.status, result.bodyText);
      log("error", `${url} -> HTTP ${result.status}`);
      return { isError: true, message };
    }

    const elapsedMs = Date.now() - start;
    phaseTrace.push({ phase: "DELIVERED", elapsedMs });
    const finalAlias = resolveAlias(instance, result.model);
    log(
      "info",
      `${instance.id} ${url} -> ${elapsedMs}ms, ${result.usage?.prompt_tokens ?? "?"}/${result.usage?.completion_tokens ?? "?"} tokens, model=${result.model || "(server default)"}`
    );
    recordUsage(instance.id, result.usage?.prompt_tokens, result.usage?.completion_tokens);

    const replyBody = buildReplyMessage({
      alias: finalAlias,
      model: result.model || instance.model || "",
      elapsedMs,
      content: result.content,
      reasoning: result.reasoning,
      usage: result.usage,
      phaseTrace: config.phasedProtocol === "markers-v1" ? phaseTrace : null,
    });
    return {
      isError: false,
      message: `${replyBody}\n\n${retentionBanner(instance)}`,
      meta: {
        alias: finalAlias,
        instanceId: instance.id,
        dataRetention: instance.dataRetention,
        model: result.model || instance.model || "",
        elapsedMs,
        usage: result.usage || {},
        tokens: result.tokenCount,
        content: result.content,
        reasoning: result.reasoning,
        phaseTrace,
      },
    };
  } catch (err) {
    clearTimeout(timer);
    const message = describeFetchError(err);
    log("error", `${url} -> stream aborted: ${message}`);
    return { isError: true, message };
  } finally {
    clearHeartbeat();
    if (busyRequest === requestId) busyRequest = null;
  }
}

// ----------------------------------------------------------------------
// inbox
// ----------------------------------------------------------------------

function writeInboxEntry(requestId, payload) {
  writeJsonAtomic(join(INBOX_DIR, `${requestId}.json`), payload);
}

function listInboxEntries() {
  if (!existsSync(INBOX_DIR)) return [];
  const now = Date.now();
  const entries = [];
  let names;
  try {
    names = readdirSync(INBOX_DIR);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const fullPath = join(INBOX_DIR, name);
    let st;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }
    if (now - st.mtimeMs > INBOX_TTL_MS) {
      try { unlinkSync(fullPath); } catch { /* best-effort */ }
      continue;
    }
    try {
      const raw = readFileSync(fullPath, "utf8");
      const parsed = JSON.parse(raw);
      entries.push({ path: fullPath, mtimeMs: st.mtimeMs, payload: parsed });
    } catch {
      // best-effort - corrupt entry, skip
    }
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return entries;
}

function deleteInboxEntry(path) {
  try { unlinkSync(path); } catch { /* best-effort */ }
}

// ----------------------------------------------------------------------
// thread surface (persistent multi-turn)
// ----------------------------------------------------------------------

function threadDir(threadId) {
  return join(SESSIONS_DIR, threadId);
}

function rolloutPath(threadId) {
  return join(threadDir(threadId), "rollout.jsonl");
}

function listThreadIds() {
  if (!existsSync(SESSIONS_DIR)) return [];
  try {
    return readdirSync(SESSIONS_DIR).filter((name) => {
      try {
        return statSync(join(SESSIONS_DIR, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function readRollout(threadId) {
  const path = rolloutPath(threadId);
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip torn entries - the next ask still works.
    }
  }
  return entries;
}

function appendRolloutEntry(threadId, entry) {
  const dir = threadDir(threadId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    appendFileSync(rolloutPath(threadId), `${JSON.stringify(entry)}\n`);
    return true;
  } catch (err) {
    log("error", `rollout append failed for ${threadId}: ${err?.message || String(err)}`);
    return false;
  }
}

/** Probe `/props` to learn the server's actual `n_ctx`. Falls back to
 * DEFAULT_N_CTX_FALLBACK on failure. */
async function probeNCtx(endpoint) {
  try {
    const url = `${endpoint.replace(/\/+$/, "")}/props`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) return DEFAULT_N_CTX_FALLBACK;
    const j = await r.json();
    const n =
      j?.default_generation_settings?.n_ctx ??
      j?.default_generation_settings?.n_ctx_train ??
      j?.n_ctx ??
      DEFAULT_N_CTX_FALLBACK;
    return typeof n === "number" && n > 0 ? n : DEFAULT_N_CTX_FALLBACK;
  } catch {
    return DEFAULT_N_CTX_FALLBACK;
  }
}

/** Project a rollout into the messages array sent to the model. The
 * latest `compact` entry (if any) becomes a synthetic user message
 * carrying its summary; every `turn` entry after it replays verbatim.
 * Reasoning content is dropped on replay (`record-only` policy). */
function projectMessagesFromRollout(entries) {
  let latestCompactIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "compact") {
      latestCompactIndex = i;
      break;
    }
  }

  const messages = [];
  if (latestCompactIndex >= 0) {
    const c = entries[latestCompactIndex];
    messages.push({
      role: "user",
      content:
        "The earlier portion of this conversation was summarized to fit context. Use this summary as background; do not reply to it directly.\n\n" +
        `[summary of turns ${c.replaced_turn_range?.[0] ?? "?"}-${c.replaced_turn_range?.[1] ?? "?"}]\n${c.summary}`,
    });
  }

  for (let i = latestCompactIndex + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e?.type !== "turn") continue;
    if (e.role === "user") {
      messages.push({ role: "user", content: e.content });
    } else if (e.role === "assistant") {
      messages.push({ role: "assistant", content: e.content });
    }
  }

  return messages;
}

/** Run a synchronous streaming call for the thread surface. Builds
 * messages from the rollout, runs the streaming call, persists the
 * turn, and returns the same {isError, message, meta} shape as
 * runStreamingCall plus a `usage` aggregation hint. */
async function runThreadAsk({ threadId, instance, config, userPrompt, systemOverride }) {
  const entries = readRollout(threadId);
  if (!entries) {
    return {
      isError: true,
      message: `No rollout found for thread '${threadId}'. Call model_bridge_thread with action='start' first.`,
    };
  }
  const meta = entries[0];
  if (meta?.type !== "session_meta") {
    return {
      isError: true,
      message: `Thread '${threadId}' rollout is missing session_meta. Repair via model_bridge_thread action='end' and start a new thread.`,
    };
  }
  // Cross-instance ask attempts route to the rollout's owning
  // instance to avoid mixing API surfaces (a Gemma rollout cannot
  // be answered by Big Pickle and vice versa).
  const ownerId = meta?.instance_id;
  if (ownerId && ownerId !== instance.id) {
    const found = (config.instances || []).find((i) => i.id === ownerId);
    if (found && (found.kind !== "remote" || !found.apiKeyMissing)) {
      instance = found;
    }
  }

  const replayed = projectMessagesFromRollout(entries);
  // Add the new user turn last.
  const userTurn = { role: "user", content: userPrompt };
  const systemContent = (systemOverride ?? config.systemPrompt ?? "").trim();
  const markerPrefix = config.phasedProtocol === "markers-v1" ? MARKER_PROMPT_PREFIX : "";

  const messages = [];
  if (systemContent.length > 0) messages.push({ role: "system", content: systemContent });
  for (const m of replayed) messages.push(m);
  messages.push({
    role: "user",
    content: `${markerPrefix}${userPrompt}`,
  });

  // Persist the user turn before the call so a crash mid-stream still
  // records the prompt.
  appendRolloutEntry(threadId, {
    type: "turn",
    ts: new Date().toISOString(),
    role: "user",
    content: userTurn.content,
  });

  const requestId = randomUUID();
  const result = await runStreamingCall({ requestId, instance, config, messages });

  if (result.isError) return result;

  // Persist assistant turn.
  appendRolloutEntry(threadId, {
    type: "turn",
    ts: new Date().toISOString(),
    role: "assistant",
    content: result.meta?.content || "",
    reasoning_content: result.meta?.reasoning || "",
    usage: result.meta?.usage || {},
    model: result.meta?.model || "",
    phase_trace: result.meta?.phaseTrace || [],
  });

  // Auto-compact check: if usage.prompt_tokens / n_ctx exceeds threshold
  // AND we have at least 4 prior turns, summarize the older half.
  const used = result.meta?.usage?.prompt_tokens ?? 0;
  const nCtx = meta.n_ctx ?? DEFAULT_N_CTX_FALLBACK;
  const threshold =
    typeof config.autoCompactThreshold === "number"
      ? config.autoCompactThreshold
      : 0.85;
  let compacted = false;
  if (used > 0 && nCtx > 0 && used / nCtx >= threshold) {
    const after = readRollout(threadId) || [];
    const turnEntries = after.filter((e) => e?.type === "turn");
    if (turnEntries.length >= 4) {
      compacted = await runAutoCompact({ threadId, instance, config, entries: after });
    }
  }

  return {
    isError: false,
    message: appendThreadFooter(result.message, {
      threadId,
      contextUsed: used,
      nCtx,
      compacted,
    }),
    meta: result.meta,
  };
}

/** Append a thread-aware footer to the streaming reply so Claude can
 * see the running context state without an extra tool call. */
function appendThreadFooter(message, { threadId, contextUsed, nCtx, compacted }) {
  const pct = nCtx > 0 ? Math.round((contextUsed / nCtx) * 100) : 0;
  const compactedNote = compacted
    ? "\n[bridge] Auto-compact ran on this turn; older history was summarized."
    : "";
  return `${message}\n\n[thread ${threadId}] context ${contextUsed}/${nCtx} tokens (${pct}%)${compactedNote}`;
}

/** Summarize the older half of the rollout via Gemma itself, replace
 * those turns with a single `compact` entry. Returns true on success. */
async function runAutoCompact({ threadId, instance, config, entries }) {
  // Find the most recent compact (if any) so we only compact the
  // un-compacted tail.
  let latestCompactIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "compact") {
      latestCompactIndex = i;
      break;
    }
  }
  const tail = entries.slice(latestCompactIndex + 1).filter((e) => e?.type === "turn");
  if (tail.length < 4) return false;

  const half = Math.floor(tail.length / 2);
  const toSummarize = tail.slice(0, half);
  const transcript = toSummarize
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join("\n\n");

  const summarizePrompt =
    "Summarize the following conversation excerpt in 6-10 sentences. " +
    "Focus on facts, decisions, and unresolved questions. The summary " +
    "will be injected back into the same conversation as background " +
    "context, so write in third-person and avoid pronouns that depend " +
    "on the original speaker turn.\n\n" +
    "---\n" +
    transcript;

  const compactRequestId = `compact-${randomUUID()}`;
  // Disable phasedProtocol for the meta call - we don't want phase
  // markers leaking into the summary text.
  const compactConfig = { ...config, phasedProtocol: "off" };
  const result = await runStreamingCall({
    requestId: compactRequestId,
    instance,
    config: compactConfig,
    messages: [{ role: "user", content: summarizePrompt }],
  });
  if (result.isError) {
    log("warn", `auto-compact summarization failed for ${threadId}: ${result.message}`);
    return false;
  }

  const summary = (result.meta?.content || "").trim();
  if (summary.length === 0) {
    log("warn", `auto-compact produced empty summary for ${threadId}`);
    return false;
  }

  // Compute the absolute turn-range of the rollout we replaced.
  const allTurns = entries.filter((e) => e?.type === "turn");
  const tailStartIndex = allTurns.length - tail.length;
  const replacedRange = [tailStartIndex + 1, tailStartIndex + half];

  // Rebuild the rollout: keep everything up to and including the
  // latest existing compact, plus the surviving second-half tail.
  const survivors = entries.slice(latestCompactIndex + 1)
    .filter((e) => e?.type !== "turn" || tail.indexOf(e) >= half);

  const next = [
    ...entries.slice(0, latestCompactIndex + 1),
    {
      type: "compact",
      ts: new Date().toISOString(),
      replaced_turn_range: replacedRange,
      summary,
      summary_tokens: result.meta?.usage?.completion_tokens ?? 0,
    },
    ...survivors,
  ];

  const ok = (() => {
    try {
      const tmp = `${rolloutPath(threadId)}.tmp`;
      const body = next.map((e) => JSON.stringify(e)).join("\n");
      writeFileSync(tmp, `${body}\n`);
      renameSync(tmp, rolloutPath(threadId));
      return true;
    } catch (err) {
      log("error", `auto-compact rewrite failed for ${threadId}: ${err?.message || String(err)}`);
      return false;
    }
  })();

  if (ok) {
    log("info", `auto-compact ${threadId}: replaced ${half} turns with ${result.meta?.usage?.completion_tokens ?? "?"}-token summary`);
  }
  return ok;
}

// ----------------------------------------------------------------------
// tool handlers
// ----------------------------------------------------------------------

/** Cheap config preflight shared by every tool handler. Returns
 * `{config, error}` - if `error` is non-null, surface it and abort. */
function preflightConfig() {
  const config = readConfig();
  if (!config) {
    return {
      config: null,
      error:
        "Model Bridge has no config on disk yet. Configure wat321.modelBridge.instances in VS Code settings, then enable the bridge.",
    };
  }
  if (!config.enabled) {
    return {
      config: null,
      error:
        "Model Bridge is disabled. Toggle wat321.modelBridge.enabled in VS Code settings.",
    };
  }
  return { config, error: null };
}

async function handleAsk(args) {
  const pre = preflightConfig();
  if (pre.error) return { isError: true, message: pre.error };
  const config = pre.config;

  const picked = pickInstance(config, typeof args?.instance_id === "string" ? args.instance_id : "");
  if (picked.error) return { isError: true, message: picked.error };
  const instance = picked.instance;

  const prompt = typeof args?.prompt === "string" ? args.prompt : "";
  if (prompt.length === 0) {
    return { isError: true, message: "prompt is required and must be a non-empty string." };
  }
  const systemOverride = typeof args?.system === "string" ? args.system : undefined;
  const isAsync = args?.async === true;

  if (busyRequest !== null) {
    return {
      isError: true,
      message:
        "Model Bridge is already handling another call. Wait for it to finish or call model_bridge_inbox to retrieve completed async results.",
    };
  }

  const requestId = randomUUID();
  const systemContent = (systemOverride ?? config.systemPrompt ?? "").trim();
  const markerPrefix = config.phasedProtocol === "markers-v1" ? MARKER_PROMPT_PREFIX : "";
  const messages = [];
  if (systemContent.length > 0) messages.push({ role: "system", content: systemContent });
  messages.push({ role: "user", content: `${markerPrefix}${prompt}` });

  if (!isAsync) {
    return runStreamingCall({ requestId, instance, config, messages });
  }

  const startedAt = new Date().toISOString();
  const alias = resolveAlias(instance, "");
  log("info", `async dispatch ${requestId} instance=${instance.id} alias=${alias}`);
  void runStreamingCall({ requestId, instance, config, messages })
    .then((result) => {
      writeInboxEntry(requestId, {
        requestId,
        completedAt: new Date().toISOString(),
        startedAt,
        alias,
        instanceId: instance.id,
        prompt: prompt.slice(0, 200),
        isError: result.isError,
        message: result.message,
        meta: result.meta || null,
      });
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", `async ${requestId} crashed: ${msg}`);
      writeInboxEntry(requestId, {
        requestId,
        completedAt: new Date().toISOString(),
        startedAt,
        alias,
        instanceId: instance.id,
        prompt: prompt.slice(0, 200),
        isError: true,
        message: `Async Model Bridge call crashed: ${msg}`,
        meta: null,
      });
    });

  return {
    isError: false,
    message: `Queued async ${alias} call. Request id: ${requestId}. Call model_bridge_inbox to retrieve the reply when it's ready.`,
  };
}

function handleInbox(args) {
  const requestId = typeof args?.requestId === "string" ? args.requestId : null;
  const peek = args?.peek === true;
  const entries = listInboxEntries();

  if (entries.length === 0) {
    const inFlight = busyRequest ? ` (one async call still in flight: ${busyRequest})` : "";
    return { isError: false, message: `Inbox is empty.${inFlight}` };
  }

  let target = entries;
  if (requestId) {
    target = entries.filter((e) => e.payload?.requestId === requestId);
    if (target.length === 0) {
      return {
        isError: false,
        message: `No inbox entry with requestId ${requestId}. Inbox has ${entries.length} other entr${entries.length === 1 ? "y" : "ies"}; call model_bridge_inbox without arguments to drain them.`,
      };
    }
  }

  const sections = target.map((entry) => {
    const p = entry.payload;
    const status = p.isError ? "ERROR" : "OK";
    const preview = (p.prompt || "").replace(/\s+/g, " ").trim();
    return `=== ${p.alias || "(model bridge)"} async ${status} (id ${p.requestId}, prompt: "${preview}") ===\n${p.message || "(empty)"}`;
  });

  if (!peek) for (const entry of target) deleteInboxEntry(entry.path);

  const tail = busyRequest ? `\n\n(one async call still in flight: ${busyRequest})` : "";
  return { isError: false, message: `${sections.join("\n\n")}${tail}` };
}

async function handleThread(args) {
  const pre = preflightConfig();
  if (pre.error) return { isError: true, message: pre.error };
  const config = pre.config;

  const action = typeof args?.action === "string" ? args.action : "";

  // list/resume/end do not need an instance - they only touch the
  // rollout files. Other actions resolve the instance up-front so the
  // outbound HTTP call has somewhere to go.
  if (action === "list") return threadList(config);
  if (action === "resume") return threadResume(args);
  if (action === "end") return threadEnd(args);

  const picked = pickInstance(config, typeof args?.instance_id === "string" ? args.instance_id : "");
  if (picked.error) return { isError: true, message: picked.error };
  const instance = picked.instance;

  switch (action) {
    case "start":     return threadStart(instance, config, args);
    case "ask":       return threadAsk(instance, config, args);
    case "compact":   return threadCompactCmd(instance, config, args);
    default:
      return {
        isError: true,
        message: `Unknown thread action '${action}'. Valid: start, ask, resume, list, end, compact.`,
      };
  }
}

function threadList(config) {
  const ids = listThreadIds();
  if (ids.length === 0) {
    return { isError: false, message: "No active Model Bridge threads. Call model_bridge_thread with action='start' to begin one." };
  }
  const aliasFor = (id) => {
    const found = (config.instances || []).find((i) => i.id === id);
    return found?.alias ?? id;
  };
  const rows = [];
  for (const id of ids) {
    const entries = readRollout(id);
    if (!entries || entries.length === 0) continue;
    const meta = entries[0];
    const turns = entries.filter((e) => e?.type === "turn").length;
    const compacts = entries.filter((e) => e?.type === "compact").length;
    const lastTurn = entries
      .filter((e) => e?.type === "turn")
      .slice(-1)[0];
    const lastTs = lastTurn?.ts ?? meta?.created_at ?? "?";
    const owner = meta?.instance_id ? aliasFor(meta.instance_id) : (meta?.alias ?? "?");
    rows.push(`  ${id}  instance=${owner}  turns=${turns}  compacts=${compacts}  lastTurn=${lastTs}`);
  }
  return { isError: false, message: `Active Model Bridge threads:\n${rows.join("\n")}` };
}

async function threadStart(instance, config, args) {
  if (busyRequest !== null) {
    return { isError: true, message: "Model Bridge is busy with another call. Try again in a moment." };
  }
  const threadId = `${instance.id}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`;
  const dir = threadDir(threadId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const nCtx = instance.kind === "local" ? await probeNCtx(instance.endpoint) : DEFAULT_N_CTX_FALLBACK;
  appendRolloutEntry(threadId, {
    type: "session_meta",
    thread_id: threadId,
    instance_id: instance.id,
    alias: resolveAlias(instance, ""),
    model: typeof instance.model === "string" ? instance.model : "",
    data_retention: instance.dataRetention,
    n_ctx: nCtx,
    created_at: new Date().toISOString(),
  });

  const initialPrompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
  if (initialPrompt.length === 0) {
    return {
      isError: false,
      message: `Started Model Bridge thread '${threadId}' on '${instance.alias}' (n_ctx=${nCtx}). Send the first turn with action='ask', thread_id='${threadId}', prompt='...'.`,
    };
  }
  const askResult = await runThreadAsk({
    threadId,
    instance,
    config,
    userPrompt: initialPrompt,
    systemOverride: typeof args?.system === "string" ? args.system : undefined,
  });
  return askResult;
}

async function threadAsk(instance, config, args) {
  const threadId = typeof args?.thread_id === "string" ? args.thread_id : "";
  const userPrompt = typeof args?.prompt === "string" ? args.prompt : "";
  if (!threadId) return { isError: true, message: "thread_id is required for action='ask'." };
  if (userPrompt.length === 0) return { isError: true, message: "prompt is required for action='ask'." };
  if (busyRequest !== null) {
    return { isError: true, message: "Model Bridge is busy with another call. Try again in a moment." };
  }
  return runThreadAsk({
    threadId,
    instance,
    config,
    userPrompt,
    systemOverride: typeof args?.system === "string" ? args.system : undefined,
  });
}

function threadResume(args) {
  const threadId = typeof args?.thread_id === "string" ? args.thread_id : "";
  if (!threadId) return { isError: true, message: "thread_id is required for action='resume'." };
  const entries = readRollout(threadId);
  if (!entries) {
    return { isError: true, message: `No rollout found for thread '${threadId}'.` };
  }
  const meta = entries[0];
  const turns = entries.filter((e) => e?.type === "turn").length;
  const compacts = entries.filter((e) => e?.type === "compact").length;
  const lastTurn = entries.filter((e) => e?.type === "turn").slice(-1)[0];
  return {
    isError: false,
    message:
      `Thread '${threadId}' loaded.\n` +
      `  alias: ${meta?.alias ?? "?"}\n` +
      `  model: ${meta?.model || "(server default)"}\n` +
      `  n_ctx: ${meta?.n_ctx ?? "?"}\n` +
      `  turns: ${turns}\n` +
      `  compacts: ${compacts}\n` +
      `  last turn: ${lastTurn?.ts ?? "(none)"}\n\n` +
      `Send the next prompt with action='ask', thread_id='${threadId}', prompt='...'.`,
  };
}

function threadEnd(args) {
  const threadId = typeof args?.thread_id === "string" ? args.thread_id : "";
  if (!threadId) return { isError: true, message: "thread_id is required for action='end'." };
  const dir = threadDir(threadId);
  if (!existsSync(dir)) {
    return { isError: false, message: `Thread '${threadId}' did not exist.` };
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    return { isError: false, message: `Thread '${threadId}' ended; rollout removed.` };
  } catch (err) {
    return { isError: true, message: `Failed to remove thread '${threadId}': ${err?.message || String(err)}` };
  }
}

async function threadCompactCmd(instance, config, args) {
  const threadId = typeof args?.thread_id === "string" ? args.thread_id : "";
  if (!threadId) return { isError: true, message: "thread_id is required for action='compact'." };
  if (busyRequest !== null) {
    return { isError: true, message: "Model Bridge is busy with another call. Try again in a moment." };
  }
  const entries = readRollout(threadId);
  if (!entries) return { isError: true, message: `No rollout found for thread '${threadId}'.` };
  const ok = await runAutoCompact({ threadId, instance, config, entries });
  return ok
    ? { isError: false, message: `Compacted thread '${threadId}'.` }
    : { isError: true, message: `Compact failed for thread '${threadId}'. See ~/.wat321/model-bridge/channel.log.` };
}

// ----------------------------------------------------------------------
// harness (OpenCode HTTP API) - tool-using sub-agent driven by a local instance
// ----------------------------------------------------------------------

/** Probe whether the OpenCode HTTP server is reachable. Hits the
 * `/doc` OpenAPI endpoint (always-on, cheap, no auth). Cached for
 * 30s so a tools/list flurry does not hammer the server. */
const harnessProbeCache = new Map();
const HARNESS_PROBE_TTL_MS = 30_000;

async function probeHarness(config) {
  if (!config.useOpenCodeHarness) return { available: false, reason: "harness disabled" };
  if (!config.openCodeServerUrl) {
    return { available: false, reason: "no OpenCode server URL resolved" };
  }
  const key = config.openCodeServerUrl;
  const cached = harnessProbeCache.get(key);
  if (cached && Date.now() - cached.at < HARNESS_PROBE_TTL_MS) {
    return cached.value;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  let value;
  try {
    const res = await fetch(`${config.openCodeServerUrl}/doc`, { signal: ac.signal });
    value = res.ok
      ? { available: true, reason: null }
      : { available: false, reason: `HTTP ${res.status} from /doc` };
  } catch (err) {
    value = {
      available: false,
      reason: err?.name === "AbortError" ? "probe timed out" : (err?.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
  harnessProbeCache.set(key, { at: Date.now(), value });
  return value;
}

/** Probe `/v1/models` on the local endpoint to discover the loaded
 * model id. llama.cpp answers chat completions with whatever's loaded
 * regardless of the request's `model` field, but OpenCode's
 * `/session/:id/message` requires an explicit `{providerID, modelID}`
 * pair - so for the harness we have to know the real model id even
 * though the catalog leaves it blank to support auto-follow.
 *
 * Cached per endpoint with a 30s TTL so a flurry of harness calls
 * doesn't pound /v1/models. The cache invalidates if the user swaps
 * models server-side (the next call after the TTL picks up the new
 * id). */
const localModelIdCache = new Map();
const LOCAL_MODEL_ID_TTL_MS = 30_000;

async function discoverLocalModelId(endpoint) {
  const key = endpoint;
  const cached = localModelIdCache.get(key);
  if (cached && Date.now() - cached.at < LOCAL_MODEL_ID_TTL_MS) {
    return cached.id;
  }
  const url = `${endpoint.replace(/\/+$/, "")}/v1/models`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  let id = "";
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (res.ok) {
      const json = await res.json();
      const first = json?.data?.[0]?.id;
      if (typeof first === "string" && first.length > 0) id = first;
    }
  } catch {
    // network or parse failure - leave id empty, caller surfaces a
    // friendly message
  } finally {
    clearTimeout(timer);
  }
  localModelIdCache.set(key, { at: Date.now(), id });
  return id;
}

/** Build the model object OpenCode expects in `/session/:id/message`
 * requests. The API rejects a slash-joined string with a 400; it
 * wants `{providerID, modelID}`. We standardize on `llama.cpp` as
 * the provider id - that's what WAT321 writes into the user's
 * opencode.json provider block during setup. For local instances,
 * we discover the loaded model id via `/v1/models` when the catalog
 * leaves it blank (the auto-follow design). */
async function buildHarnessModel(instance) {
  if (typeof instance.model === "string" && instance.model.length > 0) {
    return { providerID: "llama.cpp", modelID: instance.model };
  }
  if (instance.kind === "local") {
    const discovered = await discoverLocalModelId(instance.endpoint);
    if (discovered.length > 0) {
      return { providerID: "llama.cpp", modelID: discovered };
    }
  }
  return null;
}

/** Run a single task against the OpenCode HTTP server. Creates a
 * session (or reuses one if `sessionId` is supplied), posts the
 * message, and returns the assistant's text reply. The OpenCode
 * server runs the entire tool loop; we only see the final result. */
async function runOpenCodeTask({ instance, config, prompt, sessionId, dir, agent }) {
  const modelRef = await buildHarnessModel(instance);
  if (!modelRef) {
    return {
      isError: true,
      message:
        `model_bridge_task could not determine a model id for '${instance.id}'. Make sure llama-server is running and /v1/models returns a loaded model.`,
    };
  }
  const base = config.openCodeServerUrl;
  if (!base) {
    return { isError: true, message: "OpenCode server URL is not set." };
  }

  // Reuse a session if the caller passed one; otherwise create a new
  // one. Failing to create a session is fatal - surface the body so
  // the user can debug auth / config mismatches.
  let activeSessionId = sessionId;
  if (!activeSessionId) {
    let sessionRes;
    try {
      sessionRes = await fetch(`${base}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    } catch (err) {
      const msg = describeUndiciFetchError(err);
      log("error", `OpenCode session create failed: ${msg}`);
      return {
        isError: true,
        message: `Could not reach OpenCode server at ${base}. ${msg}`,
      };
    }
    if (!sessionRes.ok) {
      const body = await sessionRes.text().catch(() => "");
      return {
        isError: true,
        message: `OpenCode session create returned HTTP ${sessionRes.status}: ${body.slice(0, 400)}`,
      };
    }
    const sessionJson = await sessionRes.json().catch(() => ({}));
    activeSessionId = sessionJson?.id;
    if (!activeSessionId) {
      return { isError: true, message: "OpenCode session create did not return an id." };
    }
  }

  // Post the message. OpenCode's /session/:id/message endpoint blocks
  // until the assistant reply is ready (it runs the tool loop server-
  // side). Use the configured per-call timeout directly - the click
  // menu lets the user bump it for unusually long tasks. Default 180s.
  const timeoutMs =
    (typeof config.timeoutSec === "number" ? config.timeoutSec : 180) * 1000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  // OpenCode's parts schema: array of content parts. We send a single
  // text part. The server adds tool_use / tool_result parts as the
  // loop runs and surfaces the final assistant text in the response.
  const body = {
    model: modelRef,
    parts: [{ type: "text", text: prompt }],
  };
  if (dir) body.directory = dir;
  if (agent) body.agent = agent;

  let msgRes;
  try {
    msgRes = await fetch(`${base}/session/${encodeURIComponent(activeSessionId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === "AbortError") {
      return {
        isError: true,
        message: `OpenCode task timed out after ${timeoutMs}ms.`,
      };
    }
    const msg = describeUndiciFetchError(err);
    log("error", `OpenCode message post failed: ${msg}`);
    return { isError: true, message: `OpenCode server call failed: ${msg}` };
  }
  clearTimeout(timer);

  if (!msgRes.ok) {
    const text = await msgRes.text().catch(() => "");
    return {
      isError: true,
      message: `OpenCode message returned HTTP ${msgRes.status}: ${text.slice(0, 400)}`,
    };
  }

  const payload = await msgRes.json().catch(() => null);
  // OpenCode's response shape varies across versions. Try a few common
  // shapes for the assistant's final text. If none match, surface the
  // raw payload so the user can debug.
  let replyText = "";
  if (payload) {
    if (typeof payload.text === "string") {
      replyText = payload.text;
    } else if (Array.isArray(payload.parts)) {
      replyText = payload.parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n");
    } else if (Array.isArray(payload.message?.parts)) {
      replyText = payload.message.parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n");
    } else if (typeof payload.message?.text === "string") {
      replyText = payload.message.text;
    }
    if (replyText.length === 0) {
      replyText = `(OpenCode returned no text content; raw payload: ${JSON.stringify(payload).slice(0, 600)})`;
    }
  } else {
    replyText = "(OpenCode returned non-JSON response)";
  }

  return {
    isError: false,
    message: replyText,
    sessionId: activeSessionId,
  };
}

async function handleTask(args) {
  const pre = preflightConfig();
  if (pre.error) return { isError: true, message: pre.error };
  const config = pre.config;

  if (!config.useOpenCodeHarness) {
    return {
      isError: true,
      message:
        "model_bridge_task requires the OpenCode harness. Check `wat321.modelBridge.useOpenCodeHarness` in VS Code settings.",
    };
  }

  const picked = pickInstance(config, typeof args?.instance_id === "string" ? args.instance_id : "");
  if (picked.error) return { isError: true, message: picked.error };
  const instance = picked.instance;
  if (instance.kind !== "local") {
    return {
      isError: true,
      message:
        `model_bridge_task only routes to local instances; '${instance.alias}' is kind=remote. Pass instance_id of a local instance or change the active instance via the click menu.`,
    };
  }

  const probe = await probeHarness(config);
  if (!probe.available) {
    return {
      isError: true,
      message:
        `OpenCode server unreachable at ${config.openCodeServerUrl || "(unset)"}. Make sure 'opencode serve --hostname 0.0.0.0 --port 4096' is running on the box where OpenCode is installed. Reason: ${probe.reason ?? "unknown"}`,
    };
  }

  const prompt = typeof args?.prompt === "string" ? args.prompt : "";
  if (prompt.length === 0) {
    return { isError: true, message: "prompt is required and must be a non-empty string." };
  }
  const sessionId = typeof args?.session_id === "string" ? args.session_id.trim() : "";
  const dir = typeof args?.dir === "string" ? args.dir.trim() : "";
  const agent = typeof args?.agent === "string" ? args.agent.trim() : "";

  if (busyRequest !== null) {
    return {
      isError: true,
      message: "Model Bridge is busy with another call. Wait or use model_bridge_inbox if it's an async ask.",
    };
  }

  busyRequest = `task-${randomUUID()}`;
  const aliasIdle = resolveAlias(instance, "");
  const start = Date.now();
  writeHeartbeat({
    phase: "calling",
    requestId: busyRequest,
    startedAt: new Date(start).toISOString(),
    alias: aliasIdle,
    instanceId: instance.id,
    dataRetention: instance.dataRetention,
    model: typeof instance.model === "string" ? instance.model : "",
    timeoutMs: (typeof config.timeoutSec === "number" ? config.timeoutSec : 180) * 1000,
    tokens: 0,
    tokensPerSec: 0,
    currentPhase: "TASK",
    phaseTrace: [{ phase: "DISPATCH", elapsedMs: 0 }, { phase: "TASK", elapsedMs: 0 }],
  });

  try {
    const result = await runOpenCodeTask({
      instance,
      config,
      prompt,
      sessionId: sessionId || null,
      dir: dir || null,
      agent: agent || null,
    });
    const elapsedMs = Date.now() - start;
    if (result.isError) return result;
    const sessionFooter = result.sessionId
      ? `\n\n[opencode session ${result.sessionId}] continue with model_bridge_task({prompt, session_id: "${result.sessionId}"})`
      : "";
    return {
      isError: false,
      message: `--- ${aliasIdle} task reply (${elapsedMs} ms via OpenCode) ---\n\n${result.message}${sessionFooter}\n\n${retentionBanner(instance)}`,
    };
  } finally {
    clearHeartbeat();
    busyRequest = null;
  }
}

function handleList() {
  const pre = preflightConfig();
  if (pre.error) return { isError: true, message: pre.error };
  const config = pre.config;

  const rows = (config.instances || []).map((inst) => {
    const status =
      inst.kind === "remote" && inst.apiKeyMissing ? "needs API key" : "ready";
    const star = inst.id === config.activeInstanceId ? "*" : " ";
    const model = inst.model
      ? inst.model
      : inst.kind === "local"
        ? "(auto-discovered from /v1/models at call time)"
        : "(server default)";
    return `  ${star} ${inst.id}  alias='${inst.alias}'  kind=${inst.kind}  retention=${inst.dataRetention}  model=${model}  [${status}]`;
  });
  if (rows.length === 0) {
    return {
      isError: false,
      message: "No instances configured. Add entries under wat321.modelBridge.instances in VS Code settings.",
    };
  }
  const active = config.activeInstanceId
    ? `Active instance: ${config.activeInstanceId}`
    : "No active instance selected.";
  return {
    isError: false,
    message: `${active}\n\nConfigured instances (* = active):\n${rows.join("\n")}\n\nPass any 'enabled' id as instance_id to model_bridge_ask / model_bridge_thread / model_bridge_task.`,
  };
}

// ----------------------------------------------------------------------
// MCP server
// ----------------------------------------------------------------------

const server = new Server(
  { name: "wat321-model-bridge", version: "1.3.0" },
  { capabilities: { tools: {} } }
);

const TOOL_DEFS = {
  ask: {
    name: "model_bridge_ask",
    description:
      "Send a one-shot prompt to a configured Model Bridge instance (local llama.cpp / Ollama / vLLM, or cloud OpenCode Zen routes like Big Pickle / GPT-5 Nano / Ling / etc.). Streams via SSE; the WAT321 status bar shows live token rate while the call runs. Stateless - no conversation memory across calls. Pass instance_id to target a specific instance, or omit to use the click-menu's active instance. Pass async: true to dispatch in the background and retrieve the reply later via model_bridge_inbox. Reply ends with a [retention] banner naming the instance's data policy. Use model_bridge_list to discover available instances. Use model_bridge_thread for persistent multi-turn conversations or model_bridge_task for tool-using sub-agent runs.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt for the model. No conversation history is preserved across model_bridge_ask calls." },
        instance_id: { type: "string", description: "Optional id of a configured instance (e.g. 'local-llm', 'big-pickle'). Defaults to the click-menu's active instance. Call model_bridge_list to enumerate." },
        system: { type: "string", description: "Optional per-call system prompt; overrides any global system prompt configured in WAT321 settings." },
        async: { type: "boolean", description: "When true, return immediately with a request id and run the call in the background. Defaults to false (synchronous)." },
      },
      required: ["prompt"],
    },
  },
  inbox: {
    name: "model_bridge_inbox",
    description:
      "Retrieve completed asynchronous model_bridge_ask results. With no arguments, drain every completed entry. Pass peek: true to view without removing. Pass requestId to target a specific entry. Returns 'Inbox is empty.' when nothing is waiting; mentions any still-in-flight async call in a tail line. Entries older than 1 hour are swept automatically.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", description: "Specific async request id to retrieve. Leave blank to drain all completed entries." },
        peek: { type: "boolean", description: "When true, return entries without removing them. Defaults to false (drain)." },
      },
    },
  },
  thread: {
    name: "model_bridge_thread",
    description:
      "Persistent multi-turn conversation with a Model Bridge instance via WAT321's rollout (no harness needed). Each thread keeps a rollout that replays on every turn, so the model sees prior history (and llama.cpp's prefix cache hits for fast prefill). Auto-compacts when the rollout exceeds the configured fraction of n_ctx. Sub-actions: 'start', 'ask', 'resume', 'list', 'end', 'compact'. Pass instance_id on 'start' to pin the thread to a specific instance; subsequent 'ask' calls auto-route to the rollout's owning instance. Use model_bridge_task instead when you want a tool-using sub-agent (file r/w, web fetch, shell) - that one delegates session management to OpenCode.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "ask", "resume", "list", "end", "compact"], description: "Sub-action to run." },
        instance_id: { type: "string", description: "Optional instance to use for 'start'. Subsequent actions auto-route to the rollout's owning instance." },
        thread_id: { type: "string", description: "Required for ask, resume, end, compact. Returned by start." },
        prompt: { type: "string", description: "User prompt for ask. Optional first-turn prompt for start." },
        system: { type: "string", description: "Optional per-turn system prompt override." },
      },
      required: ["action"],
    },
  },
  task: {
    name: "model_bridge_task",
    description:
      "Drive the active local Model Bridge instance through a tool-using sub-agent loop via OpenCode (HTTP). Unlike model_bridge_ask (text-only) or model_bridge_thread (text-only with rollout memory), this tool gives the model access to file read/write, web fetch, shell execution, and any MCP servers OpenCode is configured with. OpenCode runs the entire tool loop server-side; Claude only sees the final result. Local instances only - cloud (kind=remote) instances cannot drive the local OpenCode harness. ALWAYS try this tool first when the active instance is local; if model_bridge_list reports the model field as auto-discovered, the bridge resolves it from /v1/models at call time. Do not preemptively reject the call based on the catalog's empty model field. Pass session_id to continue a prior task. dir scopes the working directory for file operations. agent picks a specific OpenCode agent definition (e.g. 'wat321-coder' for a minimal read/write/bash-only surface that helps small models avoid invalid tool-call cascades). OpenCode owns session persistence, history, and compact - WAT321 just forwards the request and captures the reply. Only available when the OpenCode harness is enabled, the active instance is local, AND the OpenCode server is reachable.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task instruction for the model. May reference files, URLs, etc. - the harness gives the model tools to actually read/fetch them." },
        instance_id: { type: "string", description: "Optional id of a local instance to drive. Defaults to the click-menu's active instance (rejected if it is kind=remote)." },
        session_id: { type: "string", description: "Continue a specific OpenCode session by id. Use for multi-turn workflows; the previous task's reply mentions the session id when one was created." },
        agent: { type: "string", description: "Optional OpenCode agent name to scope the tool surface. 'wat321-coder' restricts tools to read/write/bash, which improves reliability on small models. Omit to use OpenCode's default 'build' agent." },
        dir: { type: "string", description: "Working directory for the harness (file operations resolve relative to this). Defaults to OpenCode's config-defined cwd." },
      },
      required: ["prompt"],
    },
  },
  list: {
    name: "model_bridge_list",
    description:
      "Inspect configured Model Bridge instances. Returns each instance's id, alias, kind (local/remote), data retention policy, model id, and ready/needs-API-key status, with the active instance marked by an asterisk. Use this to find a valid instance_id for the other model_bridge_* tools. Local instances with model='(auto-discovered ...)' are valid harness targets - the bridge probes /v1/models at call time. Cheap - reads the local config file with no network calls.",
    inputSchema: { type: "object", properties: {} },
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Tool list is computed dynamically: ask/inbox/thread/list always
  // present, task only when a harness is selected, the active
  // instance is local, AND the OpenCode binary is reachable. This
  // keeps Claude's prompt size minimal when the harness is off or
  // unreachable - and means the user pays zero context tokens for a
  // tool that would just error.
  const tools = [TOOL_DEFS.ask, TOOL_DEFS.inbox, TOOL_DEFS.thread, TOOL_DEFS.list];
  const config = readConfig();
  if (config?.useOpenCodeHarness) {
    const active = (config.instances || []).find((i) => i.id === config.activeInstanceId);
    if (active?.kind === "local") {
      const probe = await probeHarness(config);
      if (probe.available) tools.push(TOOL_DEFS.task);
    }
  }
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments || {};
  let result;
  try {
    switch (req.params.name) {
      case "model_bridge_ask":    result = await handleAsk(args); break;
      case "model_bridge_inbox":  result = handleInbox(args); break;
      case "model_bridge_thread": result = await handleThread(args); break;
      case "model_bridge_task":   result = await handleTask(args); break;
      case "model_bridge_list":   result = handleList(); break;
      default:
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `${req.params.name} crashed: ${msg}`);
    return {
      isError: true,
      content: [{ type: "text", text: `Tool '${req.params.name}' crashed: ${msg}` }],
    };
  }
  return {
    isError: result.isError,
    content: [{ type: "text", text: result.message }],
  };
});

const transport = new StdioServerTransport();
log("info", "model-bridge channel starting");
await server.connect(transport);
