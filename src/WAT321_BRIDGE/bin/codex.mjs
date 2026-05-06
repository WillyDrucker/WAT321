/**
 * Codex target handlers for the unified WAT321 bridge.
 *
 * Minimal v1 port of the Epic Handshake dispatch path. Covers the
 * happy path (write envelope, await reply, return body) and late-
 * reply collection. Advanced modes carried in legacy
 * `src/WAT321_EPIC_HANDSHAKE/bin/channel.mjs` not yet ported here:
 *
 *   - adaptive heartbeat (ADAPTIVE_FLAG) - extends timeout while the
 *     dispatcher's per-turn heartbeat stays fresh
 *   - fire-and-forget mode (FIRE_AND_FORGET_FLAG) - returns immediately
 *     after writing the envelope
 *   - stale-heartbeat auto-abort (7-min watchdog with synthetic abort
 *     envelope deposit)
 *   - clipboard attachment sweeping
 *   - queue summary tail line
 *   - schema-fix hint when caller passes 'prompt' instead of 'text'
 *
 * Those land in v1.4.2+ as the use cases reappear. Legacy server
 * stays registered as the source of truth until the full migration
 * completes (see WDDOCS/WAT321_V141_MCP_MERGE_PLAN.md).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const EH_DIR = join(homedir(), ".wat321", "epic-handshake");
const INBOX_CLAUDE_ROOT = join(EH_DIR, "inbox", "claude");
const INBOX_CODEX_ROOT = join(EH_DIR, "inbox", "codex");
const SENT_CLAUDE_ROOT = join(EH_DIR, "sent", "claude");
const PAUSED_FLAG = join(EH_DIR, "paused.flag");

const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_SEC = 120;
const MIN_TIMEOUT_MS = 5_000;

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

/** Per-process fingerprint so envelopes routed to this server's
 * workspace are filtered from envelopes routed to a sibling VS Code's
 * server in the same `~/.wat321/` directory tree. */
const SESSION_FP = randomUUID();

function ensureDirs() {
  for (const dir of [INBOX_CLAUDE, INBOX_CODEX, SENT_CLAUDE]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeYaml(v) {
  if (/[:#\n]/.test(v)) return JSON.stringify(v);
  return v;
}

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
      try {
        val = JSON.parse(val);
      } catch {
        // keep raw
      }
    }
    fields[key] = val;
  }
  return { fields, body };
}

function writeAtomic(path, content) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/** Walk inbox/claude for envelopes addressed to this session that
 * predate the 5-second active-poll cutoff. Late replies from prior
 * timed-out prompts. Returns formatted preamble or empty string. */
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
    out.push({
      filename: f,
      body: parsed.body,
      createdAt: parsed.fields.created_at,
    });
    try {
      renameSync(p, join(SENT_CLAUDE, f));
    } catch {
      // best-effort
    }
  }
  if (out.length === 0) return "";
  const chunks = out.map(
    (r, i) =>
      `[Late reply ${i + 1}/${out.length} from Codex, originally sent ${r.createdAt || "earlier"}]\n${r.body}`
  );
  return chunks.join("\n\n---\n\n");
}

/** Find a reply envelope matching a given dispatched prompt id. */
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
    if (
      parsed.fields.reply_to !== promptId &&
      parsed.fields.chain_id !== promptId
    ) {
      continue;
    }
    return { filename: f, body: parsed.body, fields: parsed.fields };
  }
  return null;
}

/** Handle a `wat321_ask({target: "codex", ...})` call. */
export async function handleAsk(args) {
  ensureDirs();

  const prompt = typeof args?.prompt === "string" ? args.prompt : "";
  if (prompt.trim().length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "Expected a non-empty `prompt` argument for target=codex.",
        },
      ],
      isError: true,
    };
  }

  if (existsSync(PAUSED_FLAG)) {
    return {
      content: [
        {
          type: "text",
          text: "Epic Handshake is paused. Resume from the status bar widget to dispatch new prompts.",
        },
      ],
    };
  }

  const latePreamble = collectLateReplies();

  const id = randomUUID();
  const timeoutSec =
    typeof args?.timeout_sec === "number" && Number.isFinite(args.timeout_sec)
      ? args.timeout_sec
      : DEFAULT_TIMEOUT_SEC;
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, timeoutSec * 1000);

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
    body: prompt,
  });

  writeAtomic(join(INBOX_CODEX, `${id}.md`), envelope);

  const deadline = Date.now() + timeoutMs;
  let replyMatch = null;
  while (Date.now() < deadline) {
    replyMatch = findReplyEnvelope(id);
    if (replyMatch !== null) break;
    await sleep(POLL_INTERVAL_MS);
  }

  if (replyMatch === null) {
    // Final-tick rescue before returning timeout.
    replyMatch = findReplyEnvelope(id);
  }

  if (replyMatch !== null) {
    try {
      renameSync(
        join(INBOX_CLAUDE, replyMatch.filename),
        join(SENT_CLAUDE, replyMatch.filename)
      );
    } catch {
      // best-effort
    }
    const text = latePreamble
      ? `${latePreamble}\n\n---\n\n${replyMatch.body}`
      : replyMatch.body;
    return { content: [{ type: "text", text }] };
  }

  const timeoutMsg = `No reply from Codex within ${Math.round(timeoutMs / 1000)}s. The dispatcher may still be running; the reply will land in the Epic Handshake inbox if it completes. Retry with timeout_sec for longer-running analyses.`;
  return {
    content: [
      {
        type: "text",
        text: latePreamble ? `${latePreamble}\n\n---\n\n${timeoutMsg}` : timeoutMsg,
      },
    ],
  };
}

/** Handle a `wat321_inbox({target: "codex"})` call. Args are
 * accepted for parity with opencode/local handlers but Codex's late-
 * reply collection is workspace-scoped only - no peek/requestId
 * filters apply. */
export async function handleInbox(_args) {
  ensureDirs();
  const preamble = collectLateReplies();
  const text = preamble || "No pending replies from Codex. The Epic Handshake inbox is empty.";
  return { content: [{ type: "text", text }] };
}

/** Handle a `wat321_list({target: "codex"})` call. Codex doesn't have
 * configurable instances - returns a single line confirming the
 * legacy server status. */
export async function handleList(_args) {
  const text =
    "Codex bridge: one CLI instance (no per-target catalog). Use wat321_ask({target:'codex', prompt}) to dispatch.";
  return { content: [{ type: "text", text }] };
}
