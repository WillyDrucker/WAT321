#!/usr/bin/env node
/**
 * WAT321 Epic Handshake - MCP Bridge Server (sync mode)
 *
 * Registered via `claude mcp add wat321 -- node <path>`. Every Claude
 * session (terminal CLI or VS Code extension) automatically picks
 * up our `reply` tool because MCP registrations are session-start
 * global.
 *
 * Sync mode: `reply` tool writes envelope to ~/.wat321/.../inbox/codex/,
 * waits up to 120s for a matching reply envelope to land in inbox/
 * claude/, returns reply content as the tool result. Codex is driven
 * by the extension-side CodexDispatcher (separate process).
 *
 * Async push via `claude/channel` capability is declared but dormant -
 * extension sessions can't be launched with `--channels`, so no
 * notification listener fires. Left in place for forward compat if
 * Anthropic ever exposes channel activation in the extension.
 *
 * Kept lean: short tool description, minimal schema, minimal
 * instructions - every token of metadata here adds to every session's
 * context.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const EH_DIR = join(homedir(), ".wat321", "epic-handshake");
const INBOX_CLAUDE_ROOT = join(EH_DIR, "inbox", "claude");
const INBOX_CODEX_ROOT = join(EH_DIR, "inbox", "codex");
const SENT_CLAUDE_ROOT = join(EH_DIR, "sent", "claude");
const ATTACHMENTS_CLIPBOARD_DIR = join(EH_DIR, "attachments", "clipboard");
const LOG_PATH = join(EH_DIR, "channel.log");
const PAUSED_FLAG = join(EH_DIR, "paused.flag");
const FIRE_AND_FORGET_FLAG = join(EH_DIR, "fire-and-forget.flag");
const ADAPTIVE_FLAG = join(EH_DIR, "adaptive.flag");
const LOG_MAX_BYTES = 50_000;
/** TTL on staged clipboard images. Stage helper sweeps before each
 * stage, and `epic_handshake_ask` sweeps before each dispatch, so
 * stale images never accumulate beyond this window. Anything older is
 * unlinked on the next sweep. Reset WAT321 wipes the dir entirely. */
const ATTACHMENTS_TTL_MS = 5 * 60 * 1000;

/** Threshold beyond which an in-flight turn with no heartbeat updates
 * is treated as stuck. The bridge auto-aborts and writes a synthetic
 * "stale heartbeat" reply into the inbox so the next prompt or inbox
 * check surfaces the failure instead of polling forever. Issue #61. */
const STALE_HEARTBEAT_MS = 10 * 60 * 1000;

/** Per-workspace identity. Mirrors `src/WAT321_EPIC_HANDSHAKE/
 * workspaceHash.ts` so envelopes written here land in the same
 * `<wshash>` subfolder the dispatcher watches. Multiple Claude
 * sessions across multiple VS Code instances share `~/.wat321/`
 * but each workspace gets its own inbox/sent subfolder so a
 * dispatcher only sees envelopes meant for its workspace. Without
 * this partition, two dispatchers race on a shared folder and a
 * primary VS Code's dispatcher can win an envelope intended for
 * a sibling test instance, routing it through the wrong bridge
 * thread. */
const WORKSPACE_PATH = process.env.WAT321_WORKSPACE_PATH || process.cwd();
const WORKSPACE_HASH = createHash("sha256")
  .update(
    WORKSPACE_PATH.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase(),
    "utf8"
  )
  .digest("hex")
  .slice(0, 16);

const INBOX_CLAUDE = join(INBOX_CLAUDE_ROOT, WORKSPACE_HASH);
const INBOX_CODEX = join(INBOX_CODEX_ROOT, WORKSPACE_HASH);
const SENT_CLAUDE = join(SENT_CLAUDE_ROOT, WORKSPACE_HASH);
/** When adaptive mode is on the MCP tool keeps blocking as long as
 * the dispatcher's heartbeat file for this envelope stays fresh.
 * Matches TurnMonitor's default stallWindowMs in the TypeScript side.
 * When a heartbeat goes stale past this, the tool gives up even if
 * it has time left on timeoutMs - dispatcher already cut the turn. */
const HEARTBEAT_STALE_MS = 60_000;
/** Absolute ceiling on how long adaptive mode can extend the MCP
 * tool wait. Matches TurnMonitor's hardCapMs so both sides give up
 * at the same wall-clock moment. */
const ADAPTIVE_HARD_CAP_MS = 300_000;

const POLL_INTERVAL_MS = 500;

for (const dir of [INBOX_CLAUDE, INBOX_CODEX, SENT_CLAUDE]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const SESSION_FP = randomUUID();

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
    const line = `${new Date().toISOString()} [${level}] fp=${SESSION_FP.slice(0, 8)} ${msg}\n`;
    writeFileSync(LOG_PATH, line, { flag: "a" });
  } catch {
    // never throw from log
  }
}

log("info", `channel server starting (sync mode) ws=${WORKSPACE_HASH} path=${WORKSPACE_PATH}`);

// ---------------------------------------------------------------
// MCP server - minimal declaration
// ---------------------------------------------------------------

const mcp = new Server(
  { name: "wat321", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} }, // dormant; forward-compat
      // listChanged: we push tools/list_changed whenever the pause
      // flag flips. Clients that honor it refetch and see either the
      // full tools (unpaused) or an empty list (paused), zeroing the
      // ~20 token/turn catalog overhead while paused. Clients that
      // ignore it still work - the in-handler pause check returns a
      // paused message if Claude invokes the tool anyway.
      tools: { listChanged: true },
    },
    instructions:
      "The `reply` tool sends a Claude to Codex prompt synchronously. Call it when the user asks to prompt Codex (e.g. 'ask Codex to review', 'check with Codex'). Blocks until Codex responds or times out (120s default). The returned text is Codex's direct reply.",
  }
);

// Pause state tracking. channel.mjs polls the file flag and pushes
// tools/list_changed on transitions so clients that honor the
// notification can refetch - paused -> empty list (no token cost),
// unpaused -> full tools restored. A 500ms poll is negligible
// overhead and avoids fs.watch flakiness on Windows/Linux.
let pausedState = existsSync(PAUSED_FLAG);
log("info", `initial pause state: ${pausedState ? "paused" : "active"}`);

async function pollPauseState() {
  const current = existsSync(PAUSED_FLAG);
  if (current === pausedState) return;
  pausedState = current;
  log(
    "info",
    `pause flag transition: ${pausedState ? "-> paused" : "-> active"}; sending tools/list_changed`
  );
  try {
    await mcp.notification({
      method: "notifications/tools/list_changed",
      params: {},
    });
    log("info", "tools/list_changed notification sent");
  } catch (err) {
    log("error", `failed to send list_changed: ${err?.message || String(err)}`);
  }
}
setInterval(pollPauseState, 500).unref();

// ---------------------------------------------------------------
// Reply tool: blocks until Codex's reply envelope lands
// ---------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  if (pausedState) {
    log("info", "tools/list requested while paused - returning empty list");
    return { tools: [] };
  }
  log("info", "tools/list requested - returning full tool catalog");
  return {
    tools: [
      {
        name: "epic_handshake_ask",
        description:
          "Send a Claude to Codex prompt via Epic Handshake. Use when user says ask/tell/prompt Codex. Only fire for an actual current request, not past references or hypotheticals. Auto-includes pending late replies. To attach files or pasted screenshots, mention their absolute path in your prompt body and Codex will read them from disk (sandbox permitting). For pasted clipboard images, run `node ~/.wat321/epic-handshake/bin/stage-clipboard.mjs` via Bash and include the printed path in your prompt - run it ONLY when about to send a bridge prompt referencing the screenshot, not on every paste.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            timeout_sec: { type: "integer" },
          },
          required: ["text"],
        },
      },
      {
        name: "epic_handshake_inbox",
        description:
          "Retrieve pending Codex replies via Epic Handshake without sending a new Claude to Codex prompt. Use when user says check Codex inbox or check Epic Handshake.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
});

/** Diagnostic: log the shape of every tool invocation's arguments so
 * we can see what Claude Code actually forwards when the user pastes
 * images, references files, or copy-pastes large payloads alongside a
 * prompt. The tool's inputSchema only declares `text` + `timeout_sec`;
 * any other fields get silently dropped today. Surfacing them in the
 * log lets us design the attachment-passing feature from real evidence
 * instead of guessing at the MCP layer's behavior. Safe to keep on:
 * logs rotate at 50KB, bodies are truncated, no payload content
 * leaves the local machine. */
function logRequestShape(req) {
  try {
    const args = req.params.arguments || {};
    const keys = Object.keys(args);
    const shape = keys.map((k) => {
      const v = args[k];
      if (v === null) return `${k}:null`;
      if (Array.isArray(v)) {
        const first = v[0];
        const firstType =
          first && typeof first === "object" ? Object.keys(first).join(",") : typeof first;
        return `${k}:array(len=${v.length},first={${firstType}})`;
      }
      if (typeof v === "object") return `${k}:object(${Object.keys(v).join(",")})`;
      if (typeof v === "string") return `${k}:string(len=${v.length})`;
      return `${k}:${typeof v}`;
    });
    log("info", `tool=${req.params.name} arg-shape=[${shape.join(" ")}]`);
    // Also dump raw JSON so we can inspect content blocks, MIME types,
    // and resource references Claude Code might pass. Truncated at 4KB
    // so a large pasted blob does not flood the log.
    const raw = JSON.stringify(args);
    const trimmed = raw.length > 4096 ? `${raw.slice(0, 4096)}...<truncated len=${raw.length}>` : raw;
    log("info", `tool=${req.params.name} arg-raw=${trimmed}`);
  } catch (err) {
    log("warn", `arg-shape log failed: ${err?.message || String(err)}`);
  }
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  logRequestShape(req);
  if (req.params.name === "epic_handshake_inbox") {
    let preamble = collectLateReplies();
    let inFlightLine = null;
    if (!preamble) {
      // Empty inbox: surface in-flight status (or auto-abort stuck
      // turns) so the user doesn't poll forever against a dead bridge.
      // The auto-abort path deposits a synthetic envelope, so we
      // re-collect once after the call.
      inFlightLine = reportInFlightOrAbortStale();
      preamble = collectLateReplies();
    }
    const text = preamble
      ? preamble
      : inFlightLine ||
        "No pending replies from Codex. The Epic Handshake inbox is empty.";
    log(
      "info",
      `inbox tool invoked; ${
        preamble ? "returned backlog" : inFlightLine ? "in-flight status" : "empty"
      }`
    );
    return { content: [{ type: "text", text }] };
  }
  if (req.params.name !== "epic_handshake_ask") {
    throw new Error(`unknown tool: ${req.params.name}`);
  }

  // Pause check: file-based sentinel written by the VS Code status
  // bar widget's Pause action. Returns a friendly message without
  // dispatching so the user sees a clear paused state.
  if (existsSync(PAUSED_FLAG)) {
    log("info", "prompt attempted while paused; returning paused message");
    return {
      content: [
        {
          type: "text",
          text: "Epic Handshake is paused. Resume it from the status bar widget to send new Claude to Codex prompts.",
        },
      ],
    };
  }

  // Pick up any late replies from prior calls that timed out. These
  // are envelopes tagged with our fingerprint that nothing consumed.
  // Prepend them to the new reply so Claude naturally sees the
  // backlog on the next Claude to Codex prompt.
  const latePreamble = collectLateReplies();

  // Sweep stale clipboard attachments before dispatching. Combined
  // with the stage helper's own pre-stage sweep, this keeps the
  // attachments dir bounded to the 5-minute TTL window without
  // requiring a dedicated timer.
  sweepStaleAttachments();

  const args = req.params.arguments || {};
  const bodyText = args.text || "";

  const id = randomUUID();
  // 120s default covers most Claude to Codex prompts. Complex
  // analyses can exceed it; the widget surfaces the timeout and the
  // user can retry with args.timeout_sec for longer runs. Late
  // replies land in inbox/claude/ and auto-prepend on the next prompt.
  const timeoutMs = Math.max(5_000, (args.timeout_sec || 120) * 1000);

  const envelope = buildEnvelope({
    id,
    chainId: id,
    iteration: 0,
    source: "claude",
    target: "codex",
    sourceSessionFp: SESSION_FP,
    priority: "normal",
    intent: "question",
    title: "",
    workspacePath: WORKSPACE_PATH,
    replyTo: null,
    body: bodyText,
  });

  const envPath = join(INBOX_CODEX, `${id}.md`);
  writeAtomic(envPath, envelope);
  log("info", `dispatch -> codex/${id} timeout=${timeoutMs}ms`);

  // Fire-and-forget mode: return immediately after writing the
  // envelope. Dispatcher processes as usual and the reply lands in
  // inbox/claude/ as a late reply. The user retrieves manually from
  // the status bar widget or Claude picks it up on the next prompt
  // via the auto-prepended late-reply preamble. Lets the user keep
  // working in Claude without blocking for long Codex analyses.
  if (existsSync(FIRE_AND_FORGET_FLAG)) {
    log("info", `fire-and-forget mode: returning immediately for ${id}`);
    // Tool response wording is load-bearing: fire-and-forget is an
    // intentional early-return, not a timeout. Previous phrasing
    // ("Dispatched to Codex. Reply will land...") read close enough
    // to the timeout fallback that Claude was paraphrasing it to the
    // user as "Codex didn't reply within the timeout" - which is
    // confusing in a mode where no wait was attempted. Lead with the
    // explicit mode name and "no wait attempted" so Claude has no
    // reason to introduce failure-shaped language downstream.
    const text =
      "Fire-and-forget dispatch complete. The prompt was delivered to Codex and this tool returned immediately as intended - no wait was attempted and this is not a timeout. Codex will reply on its own schedule; the reply will appear in the Epic Handshake inbox (retrieve via the status bar widget, or it will auto-include on your next Claude-to-Codex prompt).";
    return {
      content: [
        {
          type: "text",
          text: latePreamble ? `${latePreamble}\n\n---\n\n${text}` : text,
        },
      ],
    };
  }

  // Poll inbox/claude for matching reply envelope. Two timeout models:
  //
  //   - Standard (adaptive.flag absent): fixed `timeoutMs` wall-clock,
  //     same behavior as before.
  //   - Adaptive (adaptive.flag present): effective deadline extends
  //     while the dispatcher's per-envelope heartbeat file stays
  //     fresh. Dispatcher writes `turn-heartbeat.<id>.json` on every
  //     TurnMonitor stage change; we give up only when the heartbeat
  //     mtime is older than HEARTBEAT_STALE_MS AND the initial
  //     `timeoutMs` grace has also elapsed. Hard-capped at
  //     ADAPTIVE_HARD_CAP_MS so a runaway turn cannot block forever.
  const adaptive = existsSync(ADAPTIVE_FLAG);
  const startedAt = Date.now();
  const initialDeadline = startedAt + timeoutMs;
  const hardDeadline = startedAt + ADAPTIVE_HARD_CAP_MS;
  const heartbeatFile = join(EH_DIR, `turn-heartbeat.${id}.json`);
  let replyContent = null;
  let replyFilename = null;

  while (true) {
    const match = findReplyEnvelope(id);
    if (match !== null) {
      replyContent = match.body;
      replyFilename = match.filename;
      break;
    }
    const now = Date.now();
    if (!adaptive) {
      if (now >= initialDeadline) break;
    } else {
      if (now >= hardDeadline) break;
      if (now >= initialDeadline) {
        // Past the initial window: only keep waiting if the
        // dispatcher's heartbeat shows recent activity. No
        // heartbeat file OR stale heartbeat = dispatcher is done
        // (or never started), so there's no reason to keep blocking.
        let heartbeatAgeMs = Infinity;
        try {
          heartbeatAgeMs = now - statSync(heartbeatFile).mtimeMs;
        } catch {
          // file missing - dispatcher either cleaned up (turn ended
          // successfully and moved reply into place, but we lost the
          // race on our prior findReplyEnvelope tick) or never wrote
          // one (pre-adaptive dispatcher). Next tick either finds
          // the reply or bails out if we cross hardDeadline.
        }
        if (heartbeatAgeMs > HEARTBEAT_STALE_MS) break;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (replyContent === null) {
    const elapsedMs = Date.now() - startedAt;
    log("warn", `timeout on codex/${id} after ${elapsedMs}ms (adaptive=${adaptive})`);
    const timeoutMsg = `Claude to Codex prompt timed out after ${Math.round(elapsedMs / 1000)}s. No reply received yet.`;
    return {
      content: [
        {
          type: "text",
          text: latePreamble ? `${latePreamble}\n\n---\n\n${timeoutMsg}` : timeoutMsg,
        },
      ],
    };
  }

  // Move delivered envelope to sent/
  try {
    const src = join(INBOX_CLAUDE, replyFilename);
    const dst = join(SENT_CLAUDE, replyFilename);
    renameSync(src, dst);
  } catch {
    // best-effort
  }

  log("info", `delivered reply for ${id}${latePreamble ? " (with late-reply preamble)" : ""}`);
  const finalText = latePreamble
    ? `${latePreamble}\n\n---\n\n${replyContent}`
    : replyContent;
  return {
    content: [{ type: "text", text: finalText }],
  };
});

/** Find any reply envelopes in inbox/claude/ tagged with our
 * fingerprint that are older than ~5 seconds (active prompts
 * poll + consume matching replies within 500ms). These are late
 * arrivals from prior timed-out prompts. Prepend them to the
 * current tool response so Claude sees the backlog naturally.
 * Consumed envelopes are moved to sent/. */
function collectLateReplies() {
  const out = [];
  const cutoff = Date.now() - 5_000;
  let files;
  try {
    files = readdirSync(INBOX_CLAUDE);
  } catch {
    return "";
  }
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const p = join(INBOX_CLAUDE, f);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.mtimeMs >= cutoff) continue;
    let raw;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const parsed = parseEnvelope(raw);
    if (!parsed) continue;
    if (parsed.fields.source_session_fp !== SESSION_FP) continue;
    out.push({ filename: f, fullPath: p, body: parsed.body, createdAt: parsed.fields.created_at });
    // Move to sent/ so it doesn't double-deliver next turn
    try {
      renameSync(p, join(SENT_CLAUDE, f));
    } catch {
      // best-effort
    }
  }
  if (out.length === 0) return "";
  log("info", `prepending ${out.length} late reply/replies from prior prompt(s)`);
  const chunks = out.map(
    (r, i) =>
      `[Late reply ${i + 1}/${out.length} from Codex, originally sent ${r.createdAt || "earlier"}]\n${r.body}`
  );
  return chunks.join("\n\n---\n\n");
}

/** Locate the freshest `turn-heartbeat.<envelopeId>.json` file written
 * for THIS workspace. Returns `{ path, parsed }` or null. The
 * heartbeat carries `workspaceHash` in its payload so we can filter
 * out heartbeats from sibling VS Code windows that share the same
 * `~/.wat321/` directory. */
function findOurHeartbeat() {
  let entries;
  try {
    entries = readdirSync(EH_DIR);
  } catch {
    return null;
  }
  let best = null;
  for (const name of entries) {
    if (!name.startsWith("turn-heartbeat.") || !name.endsWith(".json")) continue;
    const p = join(EH_DIR, name);
    let st;
    let raw;
    try {
      st = statSync(p);
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed.workspaceHash !== WORKSPACE_HASH) continue;
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { path: p, parsed, mtimeMs: st.mtimeMs };
    }
  }
  return best;
}

/** Inspect bridge state for the current workspace and either return a
 * status line (turn still in flight, heartbeat fresh) or auto-abort a
 * stuck turn (heartbeat older than `STALE_HEARTBEAT_MS`) by depositing
 * a synthetic abort reply into the inbox and clearing the heartbeat
 * file. Returns null when nothing is in flight.
 *
 * Called from the `epic_handshake_inbox` handler when no late replies
 * are pending. Issue #61. */
function reportInFlightOrAbortStale() {
  const wsInFlightFlag = join(EH_DIR, `in-flight.${WORKSPACE_HASH}.flag`);
  if (!existsSync(wsInFlightFlag)) return null;

  const hb = findOurHeartbeat();
  if (hb === null) {
    // Flag set but no heartbeat anywhere - dispatcher might be in the
    // pre-heartbeat window. Surface the bare fact so the user knows
    // something is starting; no abort yet.
    return "Epic Handshake: a Claude to Codex turn is in flight (no heartbeat yet). Try again in a few seconds.";
  }

  const now = Date.now();
  const lastProgressMs =
    typeof hb.parsed.lastProgressAt === "number"
      ? hb.parsed.lastProgressAt
      : hb.mtimeMs;
  const elapsedSinceProgress = now - lastProgressMs;
  const stage = hb.parsed.stage || "unknown";
  const envelopeId = hb.parsed.envelopeId || "unknown";

  if (elapsedSinceProgress >= STALE_HEARTBEAT_MS) {
    // Stuck turn. Auto-abort: deposit a synthetic "stale heartbeat"
    // envelope into the inbox so the next collectLateReplies pass
    // surfaces it, and unlink the heartbeat + flag files so subsequent
    // dispatches start clean.
    const abortId = randomUUID();
    const minutes = Math.round(elapsedSinceProgress / 60_000);
    const body = [
      `[Epic Handshake auto-abort: stale heartbeat]`,
      ``,
      `The previous Claude to Codex turn (envelope ${envelopeId}) stalled in stage \`${stage}\` with no heartbeat updates for ~${minutes} minute(s). The bridge has cleaned up the stuck state so the next prompt starts fresh.`,
      ``,
      `If this happens repeatedly on long-running Codex tasks, consider switching to Fire-and-Forget mode via the Epic Handshake menu so Claude returns immediately and replies land in the inbox when ready.`,
    ].join("\n");
    const envelope = buildEnvelope({
      id: abortId,
      chainId: abortId,
      iteration: 0,
      source: "codex",
      target: "claude",
      sourceSessionFp: SESSION_FP,
      priority: "normal",
      intent: "abort",
      title: "",
      workspacePath: WORKSPACE_PATH,
      replyTo: envelopeId,
      body,
    });
    try {
      writeAtomic(join(INBOX_CLAUDE, `${abortId}.md`), envelope);
    } catch (err) {
      log("warn", `auto-abort envelope write failed: ${err?.message || String(err)}`);
    }
    // Best-effort cleanup. The dispatcher's own watchers may also clean
    // these up; double-unlink is harmless because we wrap in try/catch.
    for (const cleanup of [
      hb.path,
      wsInFlightFlag,
      join(EH_DIR, `processing.${WORKSPACE_HASH}.flag`),
    ]) {
      try {
        if (existsSync(cleanup)) unlinkSync(cleanup);
      } catch {
        // best-effort
      }
    }
    log(
      "warn",
      `auto-abort stale turn envelope=${envelopeId} stage=${stage} stalled=${minutes}min`
    );
    return null;
  }

  const elapsedTotalMs =
    typeof hb.parsed.elapsedMs === "number" ? hb.parsed.elapsedMs : 0;
  const elapsedMin = Math.floor(elapsedTotalMs / 60_000);
  const elapsedSec = Math.floor((elapsedTotalMs % 60_000) / 1000);
  const elapsedStr =
    elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec}s` : `${elapsedSec}s`;
  const sinceProgressSec = Math.floor(elapsedSinceProgress / 1000);
  return `Epic Handshake: a Claude to Codex turn is in flight. Stage \`${stage}\`, ${elapsedStr} elapsed, last progress ${sinceProgressSec}s ago. Reply will land here when Codex finishes.`;
}

function findReplyEnvelope(promptId) {
  let files;
  try {
    files = readdirSync(INBOX_CLAUDE);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const p = join(INBOX_CLAUDE, f);
    let raw;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const parsed = parseEnvelope(raw);
    if (!parsed) continue;
    if (parsed.fields.source_session_fp !== SESSION_FP) continue;
    if (parsed.fields.reply_to !== promptId && parsed.fields.chain_id !== promptId) continue;
    return { filename: f, body: parsed.body, fields: parsed.fields };
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------
// Envelope ser/de (hand-rolled YAML frontmatter, no deps)
// ---------------------------------------------------------------

function buildEnvelope(fields) {
  const now = new Date().toISOString();
  const lines = ["---"];
  lines.push(`id: ${fields.id}`);
  lines.push(`chain_id: ${fields.chainId}`);
  lines.push(`iteration: ${fields.iteration}`);
  lines.push(`source: ${fields.source}`);
  lines.push(`target: ${fields.target}`);
  lines.push(`source_session_fp: ${fields.sourceSessionFp}`);
  lines.push(`priority: ${fields.priority}`);
  lines.push(`intent: ${fields.intent}`);
  lines.push(`workspace_path: ${fields.workspacePath}`);
  lines.push(`created_at: ${now}`);
  lines.push(`reply_to: ${fields.replyTo === null ? "null" : fields.replyTo}`);
  if (fields.title) lines.push(`title: ${escapeYaml(fields.title)}`);
  lines.push("---");
  lines.push("");
  lines.push(fields.body || "");
  lines.push("");
  return lines.join("\n");
}

function escapeYaml(v) {
  if (/[:#\n]/.test(v)) return JSON.stringify(v);
  return v;
}

function parseEnvelope(raw) {
  if (!raw.startsWith("---")) return null;
  const sep = raw.indexOf("\n---", 3);
  if (sep === -1) return null;
  const frontmatter = raw.slice(3, sep).trim();
  const body = raw.slice(sep + 4).replace(/^\s*\n/, "").trimEnd();
  const fields = {};
  for (const line of frontmatter.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val === "null") val = null;
    else if (val.startsWith('"')) {
      try { val = JSON.parse(val); } catch { /* keep raw */ }
    }
    fields[key] = val;
  }
  return { fields, body };
}

function writeAtomic(path, content) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

// ---------------------------------------------------------------
// Sent folder housekeeping: purge items older than 5 minutes on
// startup and again every 5 minutes. Delivered envelopes have no
// downstream consumer - the bridge conversation lives in Claude's
// own transcript, not in the filesystem.
// ---------------------------------------------------------------

const SENT_TTL_MS = 5 * 60 * 1000;

function purgeOldSent() {
  try {
    const cutoff = Date.now() - SENT_TTL_MS;
    for (const dir of [SENT_CLAUDE]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        try {
          const st = statSync(p);
          if (st.mtimeMs < cutoff) unlinkSync(p);
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // never throw from housekeeping
  }
}

/** Purge clipboard-staged images older than the TTL. Called at the top
 * of every `epic_handshake_ask` dispatch so stale images don't survive
 * a turn cycle. The stage helper itself also sweeps before staging, so
 * cleanup pressure is high regardless of which side acts first. */
function sweepStaleAttachments() {
  try {
    if (!existsSync(ATTACHMENTS_CLIPBOARD_DIR)) return;
    const cutoff = Date.now() - ATTACHMENTS_TTL_MS;
    for (const f of readdirSync(ATTACHMENTS_CLIPBOARD_DIR)) {
      const p = join(ATTACHMENTS_CLIPBOARD_DIR, f);
      try {
        const st = statSync(p);
        if (st.mtimeMs < cutoff) unlinkSync(p);
      } catch {
        // best-effort
      }
    }
  } catch {
    // never throw from housekeeping
  }
}

purgeOldSent();
setInterval(purgeOldSent, SENT_TTL_MS).unref();

// ---------------------------------------------------------------
// Connect stdio transport
// ---------------------------------------------------------------

await mcp.connect(new StdioServerTransport());
log("info", "MCP connected (sync mode ready)");
