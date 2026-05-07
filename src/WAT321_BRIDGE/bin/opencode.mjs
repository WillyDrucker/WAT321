/**
 * OpenCode + Local LLM target handlers for the unified WAT321 bridge.
 *
 * Routes through the WAT321-managed `opencode serve` subprocess
 * (lifecycle in `src/WAT321_MODEL_BRIDGE/openCodeManager.ts`).
 * Sessions are owned by OpenCode itself - stored in
 * `~/.local/share/opencode/opencode.db` - and accessed via the REST
 * Endpoints used:
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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const BRIDGE_DIR = join(homedir(), ".wat321", "bridge");
const ALIAS_PATH = join(BRIDGE_DIR, "session-aliases.json");
const MB_DIR = join(homedir(), ".wat321", "model-bridge");
const MB_CONFIG_PATH = join(MB_DIR, "config.json");
const CHANNEL_LOG_PATH = join(BRIDGE_DIR, "channel.log");

/** Append a structured trace line to the bridge's channel log. Used to
 * diagnose SSE-tap failures (the live token/tps fall back to elapsed-
 * seconds when no `message.part.updated` events arrive, so the log is
 * the only signal the tap silently failed). Best-effort. */
function logSse(message) {
  try {
    if (!existsSync(BRIDGE_DIR)) mkdirSync(BRIDGE_DIR, { recursive: true });
    writeFileSync(
      CHANNEL_LOG_PATH,
      `[${new Date().toISOString()}] [sse] ${message}\n`,
      { flag: "a" }
    );
  } catch {
    // best-effort
  }
}

// Cross-tier heartbeat write: the Model Bridge widget reads
// `~/.wat321/model-bridge/heartbeat.json` to render live "calling"
// state during dispatches. The unified bridge owns the actual call
// path now, so it has to write to the path the existing widget
// monitors. Keeps the widget code unchanged while routing all bridge
// traffic through the unified server.
const MB_HEARTBEAT_PATH = join(MB_DIR, "heartbeat.json");
// Sidecar that the MB widget consults AFTER heartbeat clears. Lets
// the widget render the last-dispatched instance's alias + retention
// even when nothing is currently in flight, so a user who just hit
// Big Pickle keeps seeing "Big Pickle" rather than reverting to the
// activeInstanceId preference (which is their default-routing choice,
// not their "what just ran" view). Survives restarts; cleared only
// on Reset WAT321.
const MB_LAST_USED_PATH = join(MB_DIR, "last-used.json");

const ANON_BASE_URL = "https://opencode.ai/zen/v1";
const DEFAULT_TIMEOUT_SEC = 120;
// 5s keepalive matches the MB widget's safety-net poll cadence so
// `startedAt` stays within the freshness window without flooding
// disk writes. The widget computes elapsed locally so a single
// stable `startedAt` plus periodic refresh is enough to keep the
// "calling" badge live across long dispatches.
const HEARTBEAT_KEEPALIVE_MS = 5_000;

function ensureDir() {
  if (!existsSync(BRIDGE_DIR)) mkdirSync(BRIDGE_DIR, { recursive: true });
}

const BRIDGE_CONFIG_PATH = join(BRIDGE_DIR, "config.json");

/** Read the bridge config's projectName field for use in standardized
 * session display labels. Falls back to "Workspace" when the config
 * isn't present yet (first activate before settings ever changed) or
 * is missing the field. The bridge tier writes config.json on activate
 * so this returns the live workspace folder name in normal operation. */
function readProjectName() {
  try {
    if (!existsSync(BRIDGE_CONFIG_PATH)) return "Workspace";
    const cfg = JSON.parse(readFileSync(BRIDGE_CONFIG_PATH, "utf8"));
    if (typeof cfg?.projectName === "string" && cfg.projectName.trim().length > 0) {
      return cfg.projectName.trim();
    }
    return "Workspace";
  } catch {
    return "Workspace";
  }
}

/** Standardized session display label used across menus and bridge
 * responses. All persistent sessions WAT321 manages follow the
 * pattern `<ProjectName> Epic Handshake Claude-to-<Target> S<n>` so
 * users see one naming convention everywhere instead of OpenCode's
 * auto-generated slugs. The alias (S1, S2, ...) stays the routing
 * key; this string is for display only. */
function formatSessionDisplayName(target, alias) {
  const targetLabel =
    target === "local" ? "Local" : target === "opencode" ? "OpenCode" : target;
  return `${readProjectName()} Epic Handshake Claude-to-${targetLabel} ${alias}`;
}

/** Atomic JSON write to the Model Bridge heartbeat path so the MB
 * widget reads a coherent file even mid-write. Best-effort: any
 * failure is silent (heartbeat absence falls back to "idle" in the
 * widget, which is the right degraded state). */
function writeMbHeartbeat(payload) {
  try {
    if (!existsSync(MB_DIR)) mkdirSync(MB_DIR, { recursive: true });
    const tmp = `${MB_HEARTBEAT_PATH}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`);
    renameSync(tmp, MB_HEARTBEAT_PATH);
  } catch {
    // best-effort - widget falls back to idle on missing/invalid file
  }
}

function clearMbHeartbeat() {
  try {
    if (existsSync(MB_HEARTBEAT_PATH)) unlinkSync(MB_HEARTBEAT_PATH);
  } catch {
    // best-effort
  }
}

/** Persist the most recently dispatched instance so the MB widget can
 * keep showing it after the heartbeat clears. Distinct from
 * `activeInstanceId` (the user's preferred default) - this is the
 * "what just ran" view, updated automatically on every successful
 * one-shot or session-attached dispatch. Best-effort. */
function writeMbLastUsed(meta) {
  try {
    if (!existsSync(MB_DIR)) mkdirSync(MB_DIR, { recursive: true });
    const payload = {
      instanceId: meta.instanceId,
      alias: meta.alias,
      dataRetention: meta.dataRetention,
      model: meta.model || "",
      at: new Date().toISOString(),
    };
    const tmp = `${MB_LAST_USED_PATH}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`);
    renameSync(tmp, MB_LAST_USED_PATH);
  } catch {
    // best-effort
  }
}

/** Wrap a dispatch with start/keepalive/clear heartbeat lifecycle so
 * the MB widget renders a live "calling" badge for the duration. The
 * keepalive interval refreshes the file's mtime + payload every 5s so
 * the widget's stale-detection logic doesn't flip the badge dark on
 * long calls. Cleared on resolve OR reject - never leaks heartbeat
 * state past the dispatch. */
async function withMbHeartbeat(meta, runDispatch) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const requestId = randomUUID();
  // Live progress closure variables. The SSE tap (see
  // tapOpenCodeEvents) calls updateProgress(charCount) on every
  // assistant text update; subsequent writeBeat calls pick up the
  // new token count. Char count is used as a token-count proxy so
  // the widget reads non-zero tokens during the blocking POST and
  // shows live tps instead of falling back to seconds-elapsed.
  let tokens = 0;
  let tokensPerSec = 0;
  const writeBeat = () => {
    writeMbHeartbeat({
      phase: "calling",
      requestId,
      startedAt,
      alias: meta.alias,
      instanceId: meta.instanceId,
      dataRetention: meta.dataRetention,
      model: meta.model || "",
      timeoutMs: meta.timeoutMs,
      tokens,
      tokensPerSec,
      currentPhase: "DISPATCH",
      phaseTrace: [],
    });
  };
  const updateProgress = (charCount) => {
    if (typeof charCount !== "number" || charCount < 0) return;
    tokens = charCount;
    const elapsedSec = Math.max(0.001, (Date.now() - startedMs) / 1000);
    tokensPerSec = Math.round(charCount / elapsedSec);
    writeBeat();
  };
  writeBeat();
  const interval = setInterval(writeBeat, HEARTBEAT_KEEPALIVE_MS);
  try {
    const result = await runDispatch(updateProgress);
    // Successful dispatch updates last-used so the widget can keep
    // displaying this instance's alias after the heartbeat clears.
    // Failure paths skip the write - showing "Big Pickle" after a
    // failed call would be misleading.
    if (result && result.ok !== false) {
      writeMbLastUsed(meta);
    }
    return result;
  } finally {
    clearInterval(interval);
    clearMbHeartbeat();
  }
}

/** Tap OpenCode's `/event` SSE stream during a session-attached
 * dispatch and feed live progress to the heartbeat. Char count of
 * the assistant's accumulating reply text serves as a token-count
 * proxy so the MB widget renders `Nt @ X/s` instead of seconds-
 * elapsed. Best-effort: any tap failure leaves the dispatch
 * untouched - the POST still completes and the response payload
 * is still parsed normally.
 *
 * Async: returns once the SSE response headers have arrived. The
 * caller must await this before firing the POST so the event
 * stream is already attached when opencode serve emits the first
 * `message.part.updated`. Without that ordering, a fast local LLM
 * dispatch can finish generating before the SSE GET completes its
 * handshake, leaving the heartbeat at tokens=0 for the entire
 * dispatch and the widget falling back to elapsed-seconds. */
async function tapOpenCodeEvents(base, expectedSessionId, onProgress) {
  const ac = new AbortController();
  const assistantMsgIds = new Set();
  const partTexts = new Map();
  const counters = {
    events: 0,
    sessionMatches: 0,
    partUpdates: 0,
    progressCalls: 0,
    pollUpdates: 0,
  };
  // Monotonic reporter: SSE and the poll fallback both push token
  // estimates through here. Without monotonic gating, a slow poll
  // could undo a higher SSE-reported value mid-dispatch.
  let lastTotal = 0;
  const pushProgress = (total) => {
    if (typeof total !== "number" || total <= lastTotal) return;
    lastTotal = total;
    try {
      onProgress(total);
      counters.progressCalls++;
    } catch {
      // best-effort - heartbeat write failure is non-fatal
    }
  };
  logSse(`tap.open base=${base} session=${expectedSessionId}`);

  let res;
  try {
    res = await fetch(`${base}/event`, {
      headers: { Accept: "text/event-stream" },
      signal: ac.signal,
    });
  } catch (err) {
    logSse(`tap.fetchFail err=${err?.message || err}`);
    return { stop: () => ac.abort() };
  }
  if (!res.ok || !res.body) {
    logSse(`tap.handshakeFail status=${res?.status} hasBody=${Boolean(res?.body)}`);
    return { stop: () => ac.abort() };
  }
  logSse(`tap.handshakeOk status=${res.status}`);

  // Poll fallback. Non-streaming providers (zen / Big Pickle and
  // friends) return the assistant reply as one big chunk after the
  // model finishes, so SSE produces zero or one part-updates and the
  // widget falls back to elapsed-seconds. Polling /session/{id}/message
  // every 2s lets the widget read in-progress text length even when
  // SSE never streams. Streaming providers still win in latency
  // because pushProgress is monotonic - whichever source reports
  // higher first sticks. Timeout/network failures are silent.
  const pollSessionMessages = async () => {
    if (!expectedSessionId) return;
    try {
      const r = await fetch(`${base}/session/${expectedSessionId}/message`);
      if (!r.ok) return;
      const messages = await r.json();
      if (!Array.isArray(messages) || messages.length === 0) return;
      const latest = messages[messages.length - 1];
      const role = latest?.info?.role;
      if (role !== "assistant") return;
      const parts = Array.isArray(latest?.parts) ? latest.parts : [];
      let total = 0;
      for (const p of parts) {
        if (p?.type === "text" && typeof p.text === "string") {
          total += p.text.length;
        }
      }
      if (total > 0) {
        counters.pollUpdates++;
        pushProgress(total);
      }
    } catch {
      // best-effort - polling errors don't block the dispatch
    }
  };
  const pollInterval = setInterval(pollSessionMessages, 2000);

  const reader = res.body.getReader();
  (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Find next event boundary (blank line, LF or CRLF framing).
        for (;;) {
          const lfIdx = buffer.indexOf("\n\n");
          const crlfIdx = buffer.indexOf("\r\n\r\n");
          let boundary;
          let advance;
          if (lfIdx < 0 && crlfIdx < 0) break;
          else if (lfIdx < 0) {
            boundary = crlfIdx;
            advance = 4;
          } else if (crlfIdx < 0 || lfIdx < crlfIdx) {
            boundary = lfIdx;
            advance = 2;
          } else {
            boundary = crlfIdx;
            advance = 4;
          }
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + advance);
          const dataLines = block
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).replace(/^ /, ""));
          if (dataLines.length === 0) continue;
          let evt;
          try {
            evt = JSON.parse(dataLines.join("\n"));
          } catch {
            continue;
          }
          counters.events++;
          if (counters.events <= 3) {
            logSse(`tap.event#${counters.events} type=${evt?.type} sid=${evt?.properties?.sessionID}`);
          }
          const sid = evt?.properties?.sessionID;
          if (expectedSessionId && sid !== expectedSessionId) continue;
          counters.sessionMatches++;
          if (evt.type === "message.updated") {
            const info = evt.properties?.info;
            if (info?.role === "assistant" && info?.id) {
              assistantMsgIds.add(info.id);
            }
          } else if (evt.type === "message.part.updated") {
            counters.partUpdates++;
            const part = evt.properties?.part;
            // Race-tolerant: text part-updates arrive before the
            // corresponding message.updated registers the messageID
            // as assistant. opencode serve only emits text part-
            // updates for assistant messages, so any text part with
            // a messageID is safe to count without gating on prior
            // assistant registration. Earlier guard discarded the
            // first text frame on every dispatch.
            if (part?.type === "text" && part?.messageID && part?.id) {
              const text = typeof part.text === "string" ? part.text : "";
              partTexts.set(part.id, text);
              let total = 0;
              for (const t of partTexts.values()) total += t.length;
              pushProgress(total);
            } else if (counters.partUpdates <= 2) {
              logSse(
                `tap.partSkip type=${part?.type} hasMsgId=${Boolean(part?.messageID)}`
              );
            }
          }
        }
      }
    } catch {
      // stream ended or aborted - dispatch still completes
    }
  })();

  return {
    stop: () => {
      ac.abort();
      clearInterval(pollInterval);
      logSse(
        `tap.stop events=${counters.events} sessionMatches=${counters.sessionMatches} partUpdates=${counters.partUpdates} pollUpdates=${counters.pollUpdates} progressCalls=${counters.progressCalls}`
      );
    },
  };
}

/** Normalize a per-target alias bucket to `{sessionId, instanceId}`.
 * Legacy entries stored bare session-id strings; those become
 * `{sessionId, instanceId: null}` on read so existing users keep
 * their sessions through upgrade. Null instanceId
 * means "unknown" - heartbeat callers fall back to the active instance
 * for those entries until the alias is recreated. */
function normalizeAliasBucket(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [alias, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      out[alias] = { sessionId: value, instanceId: null };
      continue;
    }
    if (value && typeof value === "object" && typeof value.sessionId === "string") {
      out[alias] = {
        sessionId: value.sessionId,
        instanceId:
          typeof value.instanceId === "string" && value.instanceId.length > 0
            ? value.instanceId
            : null,
      };
    }
  }
  return out;
}

function emptyAliasMap() {
  return {
    opencode: {},
    local: {},
    activeAliases: { opencode: null, local: null },
  };
}

function normalizeActiveAlias(raw, bucket) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw in bucket ? raw : null;
}

function readAliases() {
  ensureDir();
  if (!existsSync(ALIAS_PATH)) return emptyAliasMap();
  try {
    const parsed = JSON.parse(readFileSync(ALIAS_PATH, "utf8"));
    const opencode = normalizeAliasBucket(parsed?.opencode);
    const local = normalizeAliasBucket(parsed?.local);
    return {
      opencode,
      local,
      activeAliases: {
        opencode: normalizeActiveAlias(parsed?.activeAliases?.opencode, opencode),
        local: normalizeActiveAlias(parsed?.activeAliases?.local, local),
      },
    };
  } catch {
    return emptyAliasMap();
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

/** Resolve a catalog instance by id, with an optional target-kind
 * filter applied to the active-instance fallback. Without the kind
 * filter, an opencode session would inherit a local-kind active
 * instance when activeInstanceId points there - opencode sessions
 * end up bound to Local LLM by mistake. Passing kind="remote" or
 * kind="local" forces the fallback to skip a mismatched active
 * instance and pick one that fits the target. Explicit `id` lookups
 * skip the filter (callers asking for a specific instance know what
 * they want). */
function findInstance(id, kind = null) {
  const instances = readInstances();
  if (!id) {
    if (!existsSync(MB_CONFIG_PATH)) {
      return instances.find((i) => kind === null || i.kind === kind) || null;
    }
    try {
      const cfg = JSON.parse(readFileSync(MB_CONFIG_PATH, "utf8"));
      const activeId = typeof cfg?.activeInstanceId === "string" ? cfg.activeInstanceId : null;
      if (activeId) {
        const active = instances.find((i) => i.id === activeId);
        if (active && (kind === null || active.kind === kind)) return active;
      }
      return instances.find((i) => kind === null || i.kind === kind) || null;
    } catch {
      return instances.find((i) => kind === null || i.kind === kind) || null;
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
 * anything new. Backs the empty-prompt + session retrieval path on
 * handleAsk so callers can re-emit the most recent assistant turn
 * without paying for another generation. */
async function retrieveLatestSessionMessage(target, sessionAlias) {
  const map = readAliases();
  const aliasEntry = map[target]?.[sessionAlias];
  if (!aliasEntry) {
    return errorResult(
      `Session alias '${sessionAlias}' not found for target=${target}.`
    );
  }
  const sessionId = aliasEntry.sessionId;
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
 * without sending anything new (re-read pattern; saves a generation
 * round trip). */
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

  // Resolve session: explicit alias wins, else fall back to the active
  // alias the EH menu tracks for this target. Lets callers omit
  // `session` and dispatch through whatever the user has marked active
  // in the widget.
  let resolvedAlias = sessionAlias;
  if (resolvedAlias === null) {
    const aliasMap = readAliases();
    const active = aliasMap.activeAliases?.[target] ?? null;
    if (active && aliasMap[target]?.[active]) {
      resolvedAlias = active;
    }
  }

  // Codex-flow auto-create: caller omitted `session` and no active
  // alias is set. Spawn a fresh opencode session, persist it as the
  // new active alias, and continue into the session-attached path
  // below. Subsequent dispatches reuse the same alias until the user
  // resets or deletes via the EH menu. Without this, a RESET from the
  // menu would leave the next prompt unable to dispatch (the session-
  // attached branch errors on a missing alias).
  if (sessionAlias === null && resolvedAlias === null) {
    const serveUrl = readServeUrl();
    if (serveUrl === null) {
      return errorResult(
        "opencode serve is not running. Enable OpenCode in WAT321 settings, then retry."
      );
    }
    const targetKind = target === "local" ? "local" : "remote";
    const autoInstance = findInstance(instanceId, targetKind);
    if (target === "local" && !autoInstance) {
      return errorResult(
        "target=local requires a configured local catalog entry. Set Local Endpoint in WAT321 settings, then retry."
      );
    }
    const body = {};
    if (autoInstance?.model) {
      body.model = {
        id: autoInstance.model,
        providerID: autoInstance.harnessProviderID || "zen",
      };
    }
    try {
      const res = await fetch(`${serveUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        return errorResult(
          `Auto-create session failed: opencode serve returned ${res.status}.`
        );
      }
      const data = await res.json();
      const newSessionId = data?.id;
      if (!newSessionId) {
        return errorResult(
          "Auto-create session failed: opencode serve returned no id."
        );
      }
      const refreshed = readAliases();
      refreshed[target] = refreshed[target] || {};
      const newAlias = nextAlias(target);
      refreshed[target][newAlias] = {
        sessionId: newSessionId,
        instanceId: autoInstance?.id ?? null,
      };
      refreshed.activeAliases = refreshed.activeAliases || {
        opencode: null,
        local: null,
      };
      refreshed.activeAliases[target] = newAlias;
      writeAliases(refreshed);
      resolvedAlias = newAlias;
    } catch (err) {
      return errorResult(
        `Auto-create session failed: ${err?.message || String(err)}`
      );
    }
  }

  // Session-attached path: lookup alias, POST to /session/{id}/message.
  if (resolvedAlias !== null) {
    const map = readAliases();
    const aliasEntry = map[target]?.[resolvedAlias];
    if (!aliasEntry) {
      return errorResult(
        `Session alias '${resolvedAlias}' not found for target=${target}. Create it first via wat321_session({target:'${target}', action:'create'}).`
      );
    }
    const sessionId = aliasEntry.sessionId;
    const serveUrl = readServeUrl();
    if (serveUrl === null) {
      return errorResult(
        `opencode serve is not running. Enable Model Bridge in WAT321 settings, then retry.`
      );
    }
    // Resolve instance metadata for the heartbeat payload. Prefer the
    // bound instanceId stored at create time so the MB widget shows the
    // session's actual model rather than the user's currently-active
    // instance (which may have drifted after the session was created).
    // Legacy alias entries with null instanceId fall back to the
    // target-kind-filtered active instance.
    const targetKind = target === "local" ? "local" : "remote";
    const sessionInstance =
      (aliasEntry.instanceId ? findInstance(aliasEntry.instanceId) : null) ||
      findInstance(null, targetKind) ||
      null;
    const meta = {
      alias: sessionInstance?.alias || (target === "local" ? "Local LLM" : "OpenCode"),
      instanceId: sessionInstance?.id || target,
      dataRetention: sessionInstance?.dataRetention || (target === "local" ? "local" : "retained"),
      model: sessionInstance?.model || "",
      timeoutMs,
    };
    // SSE-tap the /event stream during the blocking POST so the MB
    // widget shows live tokens + tps instead of seconds-elapsed.
    // Awaited so the SSE GET handshake completes before the POST
    // fires - otherwise a fast local LLM dispatch can finish
    // generating before the tap is attached and we miss every event.
    // tap.stop() in finally releases the SSE reader as soon as the
    // POST settles regardless of success/failure.
    const result = await withMbHeartbeat(meta, async (updateProgress) => {
      const tap = await tapOpenCodeEvents(serveUrl, sessionId, updateProgress);
      try {
        return await postSessionMessage(serveUrl, sessionId, prompt, timeoutMs);
      } finally {
        tap.stop();
      }
    });
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
  const oneShotMeta = {
    alias: instance?.alias || "Big Pickle",
    instanceId: instance?.id || "big-pickle",
    dataRetention: instance?.dataRetention || "retained",
    model: modelSlug,
    timeoutMs,
  };
  const result = await withMbHeartbeat(oneShotMeta, () =>
    anonymousChatCompletion(modelSlug, prompt, timeoutMs)
  );
  if (!result.ok) {
    return errorResult(`One-shot dispatch failed: ${result.error}`);
  }
  let text = result.text;
  if (result.actualModel && result.actualModel !== modelSlug) {
    text += `\n\n[routed via ${result.actualModel}; cost: ${result.cost ?? "?"}]`;
  }
  return { content: [{ type: "text", text }] };
}

/** MCP resource backing `bridge://sessions/{target}` for target in
 * {opencode, local}. Returns the session alias map enriched with
 * standardized display names, the underlying session id, and the
 * bound catalog instance (model + alias) when the alias entry has
 * a tracked instanceId. Legacy entries that pre-date instanceId
 * tracking report `instance: null`. Empty map = no active sessions. */
export async function listSessionsResource(target) {
  if (target !== "opencode" && target !== "local") {
    return { sessions: [], note: `Unknown target '${target}'.` };
  }
  const map = readAliases();
  const aliases = map[target] || {};
  const instances = readInstances();
  const sessions = Object.entries(aliases).map(([alias, entry]) => {
    const boundInstance = entry.instanceId
      ? instances.find((i) => i.id === entry.instanceId) ?? null
      : null;
    return {
      alias,
      sessionId: entry.sessionId,
      displayName: formatSessionDisplayName(target, alias),
      instance: boundInstance
        ? {
            id: boundInstance.id,
            alias: boundInstance.alias,
            model: boundInstance.model,
          }
        : null,
    };
  });
  return { sessions };
}


/** Handle `wat321_session({target, action, ...})`. Action enum is
 * create / delete / rename only - listing moved to the
 * `bridge://sessions/{target}` MCP resource. */
export async function handleSession(args) {
  const target = args?.target;
  const action = args?.action;
  const map = readAliases();

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
    //
    // Target-kind filter: when no instance_id is supplied and the
    // user's active instance is the wrong kind (e.g. local-llm active
    // but creating an opencode session), skip the active and fall
    // back to a target-kind-matching instance. Without this, an
    // opencode session would inherit a local-kind instance's empty
    // model id and OpenCode would route it to llama.cpp instead of
    // the cloud catalog.
    const instanceId = typeof args?.instance_id === "string" ? args.instance_id : null;
    const targetKind = target === "local" ? "local" : "remote";
    const instance = findInstance(instanceId, targetKind);
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
      map[target][alias] = { sessionId, instanceId: instance?.id ?? null };
      // Mark new session as the active alias so the EH menu's CURRENT
      // row reflects what was just created without needing the user
      // to switch manually.
      map.activeAliases = map.activeAliases || { opencode: null, local: null };
      map.activeAliases[target] = alias;
      writeAliases(map);
      const modelLabel = instance?.alias || data?.model?.id || "default model";
      const displayName = formatSessionDisplayName(target, alias);
      return {
        content: [
          {
            type: "text",
            text: `Created session "${displayName}" (model: ${modelLabel}) -> ${sessionId}. Use wat321_ask({target:'${target}', session:'${alias}', prompt:'...'}) to dispatch.`,
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
      const sessionId = map[target][alias]?.sessionId;
      delete map[target][alias];
      // Clear active if we just deleted it; next dispatch falls back
      // to "create on first use" when the menu's CURRENT row is blank.
      map.activeAliases = map.activeAliases || { opencode: null, local: null };
      if (map.activeAliases[target] === alias) {
        map.activeAliases[target] = null;
      }
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
    map.activeAliases = map.activeAliases || { opencode: null, local: null };
    if (map.activeAliases[target] === alias) {
      map.activeAliases[target] = newName;
    }
    writeAliases(map);
    return {
      content: [{ type: "text", text: `Renamed ${alias} -> ${newName}.` }],
    };
  }

  return errorResult(`Unknown action '${action}'. Expected create, delete, or rename.`);
}
