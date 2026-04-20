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
import { randomUUID } from "node:crypto";

const EH_DIR = join(homedir(), ".wat321", "epic-handshake");
const INBOX_CLAUDE = join(EH_DIR, "inbox", "claude");
const INBOX_CODEX = join(EH_DIR, "inbox", "codex");
const SENT_CLAUDE = join(EH_DIR, "sent", "claude");
const LOG_PATH = join(EH_DIR, "channel.log");
const PAUSED_FLAG = join(EH_DIR, "paused.flag");
const FIRE_AND_FORGET_FLAG = join(EH_DIR, "fire-and-forget.flag");
const LOG_MAX_BYTES = 50_000;

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

log("info", "channel server starting (sync mode)");

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
          "Send a Claude to Codex prompt via Epic Handshake. Use when user says ask/tell/prompt Codex. Only fire for an actual current request, not past references or hypotheticals. Auto-includes pending late replies.",
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

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "epic_handshake_inbox") {
    const preamble = collectLateReplies();
    const text = preamble
      ? preamble
      : "No pending replies from Codex. The Epic Handshake inbox is empty.";
    log("info", `inbox tool invoked; ${preamble ? "returned backlog" : "empty"}`);
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

  const args = req.params.arguments || {};

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
    workspacePath: process.env.WAT321_WORKSPACE_PATH || process.cwd(),
    replyTo: null,
    body: args.text,
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
    const text =
      "Dispatched to Codex. Reply will land in the Epic Handshake inbox when done - pick \"Retrieve late replies\" from the status bar widget, or I'll auto-include it on your next Claude-to-Codex prompt.";
    return {
      content: [
        {
          type: "text",
          text: latePreamble ? `${latePreamble}\n\n---\n\n${text}` : text,
        },
      ],
    };
  }

  // Poll inbox/claude for matching reply envelope
  const deadline = Date.now() + timeoutMs;
  let replyContent = null;
  let replyFilename = null;

  while (Date.now() < deadline) {
    const match = findReplyEnvelope(id);
    if (match !== null) {
      replyContent = match.body;
      replyFilename = match.filename;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (replyContent === null) {
    log("warn", `timeout on codex/${id} after ${timeoutMs}ms`);
    const timeoutMsg = `Claude to Codex prompt timed out after ${timeoutMs / 1000}s. No reply received yet.`;
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
 * fingerprint that are older than ~15 seconds (active prompts
 * poll + consume matching replies within 500ms). These are late
 * arrivals from prior timed-out prompts. Prepend them to the
 * current tool response so Claude sees the backlog naturally.
 * Consumed envelopes are moved to sent/. */
function collectLateReplies() {
  const out = [];
  const cutoff = Date.now() - 15_000;
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

purgeOldSent();
setInterval(purgeOldSent, SENT_TTL_MS).unref();

// ---------------------------------------------------------------
// Connect stdio transport
// ---------------------------------------------------------------

await mcp.connect(new StdioServerTransport());
log("info", "MCP connected (sync mode ready)");
