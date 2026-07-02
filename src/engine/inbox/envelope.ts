import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../../shared/fs/atomicWrite";

/**
 * Unified envelope format for the WAT321 bridge mailbox.
 *
 * Both directions of every bridge dispatch (outbound prompt + inbound
 * reply) travel as a serialized envelope on disk. The shape is
 * deliberately a superset:
 *   - Codex (Epic Handshake) uses the full schema below with all
 *     `chainId`, `source`, `intent`, etc. fields populated.
 *   - OpenCode / Local LLM use the same shape but populate the minimum
 *     viable subset: `id`, `target`, `alias`, `body`, `createdAt`,
 *     timestamps, optional `waitMode`, `prompt` (outbound only),
 *     `replyToId` (inbound only).
 *
 * Designed as a superset so a future merged-inbox UI can render both
 * directions and both tiers without per-source switches. Each tier
 * still owns its own routing semantics - the envelope just carries the
 * data.
 *
 * YAML frontmatter + markdown body, atomic tmp+rename on write. Hand-
 * rolled serializer keeps this module dependency-free.
 */

export type EnvelopeKind = "outbound" | "inbound";
export type EnvelopeTarget = "codex" | "opencode" | "local";
export type EnvelopeWaitMode = "standard" | "adaptive" | "fire-and-forget";
export type EnvelopePriority = "low" | "normal" | "high";

/** Codex-only: the conversational agent labels Epic Handshake uses.
 * Kept on the unified envelope for back-compat with existing Codex
 * envelopes. Non-Codex tiers leave both unset. */
export type EnvelopeAgent = "claude" | "codex";

export interface Envelope {
  /** UUID for this envelope. Filename is `<id>.md`. */
  id: string;
  /** "outbound" = prompt heading to a backend - "inbound" = reply
   * coming back. Set by the writer based on which directory the file
   * is destined for - readers can use it as a quick disambiguator. */
  kind: EnvelopeKind;
  /** Backend that ultimately handles (outbound) or produced (inbound)
   * the message. */
  target: EnvelopeTarget;
  /** ISO 8601 wall-clock stamp at write time. */
  createdAt: string;
  /** Markdown body. For outbound, the user prompt. For inbound, the
   * backend's response. */
  body: string;

  /** Workspace path the dispatch originated in. Lets dispatchers
   * scope envelope visibility to the workspace that produced them. */
  workspacePath?: string;

  /** Human-readable alias surfaced in tool responses + status bar
   * tooltips. "Codex" / "Big Pickle" / "Local LLM" etc. */
  alias?: string;

  /** Per-call wait mode the MCP caller asked for. Dispatchers honor
   * this over the sticky flag when set. */
  waitMode?: EnvelopeWaitMode;

  /** Explicit session alias the caller asked the dispatch to attach
   * to (e.g. "S1", "S2"). Used by the OpenCode / Local LLM dispatcher
   * to pin a fire-and-forget dispatch to a specific user-created
   * session, overriding the active alias the dispatcher would
   * otherwise pick from disk. Without this, an explicit `session`
   * arg on `wat321_ask` would be silently dropped when the call goes
   * through the detached FF path. */
  sessionAlias?: string;

  /** For inbound envelopes: id of the outbound envelope this is a
   * reply to. Lets the MCP-side poller match replies. */
  replyToId?: string;

  /** Outbound only: short preview of the prompt for status bar /
   * audit purposes. Limited to ~200 chars. */
  promptPreview?: string;

  /** Inbound only: true when the dispatch errored. Body carries the
   * error message. */
  error?: boolean;

  // === Codex-only optional fields (Epic Handshake legacy) ===

  chainId?: string;
  iteration?: number;
  source?: EnvelopeAgent;
  codexTarget?: EnvelopeAgent;
  sourceSessionFp?: string;
  priority?: EnvelopePriority;
  intent?: string;
  title?: string;
  /** Replaces `replyToId` for Codex which has its own naming. Either
   * field is acceptable on the wire - readers normalize. */
  replyTo?: string | null;
}

export function newEnvelopeId(): string {
  return randomUUID();
}

function esc(v: string): string {
  if (/[:#\n]/.test(v)) return JSON.stringify(v);
  return v;
}

/** Truncate + flatten newlines for the prompt-preview frontmatter
 * field. Caller passes the full prompt - serializer takes the first
 * 200 chars and adds an ellipsis if truncation happened. */
function buildPreview(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  if (prompt.length <= 200) return prompt.replace(/\n/g, " ");
  return `${prompt.slice(0, 200).replace(/\n/g, " ")}...`;
}

export function serializeEnvelope(env: Envelope): string {
  const lines: string[] = ["---"];
  lines.push(`id: ${env.id}`);
  lines.push(`kind: ${env.kind}`);
  lines.push(`target: ${env.target}`);
  lines.push(`created_at: ${env.createdAt}`);
  if (env.workspacePath) lines.push(`workspace_path: ${esc(env.workspacePath)}`);
  if (env.alias) lines.push(`alias: ${esc(env.alias)}`);
  if (env.waitMode) lines.push(`wait_mode: ${env.waitMode}`);
  if (env.sessionAlias) lines.push(`session_alias: ${env.sessionAlias}`);
  if (env.replyToId) lines.push(`reply_to_id: ${env.replyToId}`);
  if (env.promptPreview) {
    lines.push(`prompt_preview: ${esc(env.promptPreview)}`);
  }
  if (env.error === true) lines.push(`error: true`);

  // Codex legacy fields - only emitted when present so non-Codex
  // envelopes stay clean.
  if (env.chainId) lines.push(`chain_id: ${env.chainId}`);
  if (env.iteration !== undefined) lines.push(`iteration: ${env.iteration}`);
  if (env.source) lines.push(`source: ${env.source}`);
  if (env.codexTarget) lines.push(`codex_target: ${env.codexTarget}`);
  if (env.sourceSessionFp) {
    lines.push(`source_session_fp: ${env.sourceSessionFp}`);
  }
  if (env.priority) lines.push(`priority: ${env.priority}`);
  if (env.intent) lines.push(`intent: ${env.intent}`);
  if (env.title) lines.push(`title: ${esc(env.title)}`);
  if (env.replyTo !== undefined) {
    lines.push(`reply_to: ${env.replyTo === null ? "null" : env.replyTo}`);
  }

  lines.push("---", "");
  lines.push(env.body);
  lines.push("");
  return lines.join("\n");
}

export function parseEnvelope(raw: string): Envelope | null {
  if (!raw.startsWith("---")) return null;
  const sep = raw.indexOf("\n---", 3);
  if (sep === -1) return null;
  const frontmatter = raw.slice(3, sep).trim();
  const body = raw.slice(sep + 4).replace(/^\s*\n/, "").trimEnd();

  const fields: Record<string, string | null> = {};
  for (const line of frontmatter.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val: string | null = m[2].trim();
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

  if (!fields.id) return null;
  if (!fields.target) return null;
  if (!fields.created_at) return null;

  // Derive kind from explicit field (new envelopes) or infer from
  // chain_id presence (legacy Codex envelopes - inbound replies from
  // Codex carry chain_id - outbound prompts from Claude do too, but
  // both have it).
  let kind: EnvelopeKind = "inbound";
  if (fields.kind === "outbound" || fields.kind === "inbound") {
    kind = fields.kind;
  }

  const rawWaitMode = fields.wait_mode;
  const waitMode: EnvelopeWaitMode | undefined =
    rawWaitMode === "standard" ||
    rawWaitMode === "adaptive" ||
    rawWaitMode === "fire-and-forget"
      ? rawWaitMode
      : undefined;

  const target = fields.target as EnvelopeTarget;
  if (target !== "codex" && target !== "opencode" && target !== "local") {
    return null;
  }

  return {
    id: fields.id as string,
    kind,
    target,
    createdAt: fields.created_at as string,
    body,
    workspacePath: (fields.workspace_path as string) || undefined,
    alias: (fields.alias as string) || undefined,
    waitMode,
    sessionAlias: (fields.session_alias as string) || undefined,
    replyToId:
      (fields.reply_to_id as string) ||
      (fields.reply_to && fields.reply_to !== "null"
        ? (fields.reply_to as string)
        : undefined),
    promptPreview: (fields.prompt_preview as string) || undefined,
    error: fields.error === "true",
    chainId: (fields.chain_id as string) || undefined,
    iteration:
      fields.iteration !== undefined && fields.iteration !== null
        ? Number(fields.iteration)
        : undefined,
    source: (fields.source as EnvelopeAgent) || undefined,
    codexTarget: (fields.codex_target as EnvelopeAgent) || undefined,
    sourceSessionFp: (fields.source_session_fp as string) || undefined,
    priority: (fields.priority as EnvelopePriority) || undefined,
    intent: (fields.intent as string) || undefined,
    title: (fields.title as string) || undefined,
    replyTo: fields.reply_to,
  };
}

export function writeEnvelopeAtomic(path: string, env: Envelope): void {
  writeFileAtomic(path, serializeEnvelope(env));
}

export function readEnvelope(path: string): Envelope | null {
  try {
    const raw = readFileSync(path, "utf8");
    return parseEnvelope(raw);
  } catch {
    return null;
  }
}

/** Convenience: build the in-memory shape for a brand-new outbound
 * envelope without forcing every caller to assemble all the optional
 * fields by hand. Codex callers pass the EH-specific fields via
 * `codexExtras` - non-Codex callers omit those. */
export function buildOutboundEnvelope(input: {
  target: EnvelopeTarget;
  prompt: string;
  workspacePath?: string;
  alias?: string;
  waitMode?: EnvelopeWaitMode;
  sessionAlias?: string;
  codexExtras?: {
    chainId: string;
    iteration: number;
    source: EnvelopeAgent;
    codexTarget: EnvelopeAgent;
    sourceSessionFp: string;
    priority?: EnvelopePriority;
    intent?: string;
    title?: string;
    replyTo?: string | null;
  };
}): Envelope {
  const id = newEnvelopeId();
  return {
    id,
    kind: "outbound",
    target: input.target,
    createdAt: new Date().toISOString(),
    body: input.prompt,
    workspacePath: input.workspacePath,
    alias: input.alias,
    waitMode: input.waitMode,
    sessionAlias: input.sessionAlias,
    promptPreview: buildPreview(input.prompt),
    chainId: input.codexExtras?.chainId,
    iteration: input.codexExtras?.iteration,
    source: input.codexExtras?.source,
    codexTarget: input.codexExtras?.codexTarget,
    sourceSessionFp: input.codexExtras?.sourceSessionFp,
    priority: input.codexExtras?.priority,
    intent: input.codexExtras?.intent,
    title: input.codexExtras?.title,
    replyTo: input.codexExtras?.replyTo,
  };
}

/** Build the in-memory shape for an inbound reply. `replyToId` is the
 * outbound envelope id this reply matches - the MCP poller uses it. */
export function buildInboundEnvelope(input: {
  target: EnvelopeTarget;
  body: string;
  replyToId?: string;
  workspacePath?: string;
  alias?: string;
  error?: boolean;
  codexExtras?: {
    chainId: string;
    iteration: number;
    source: EnvelopeAgent;
    codexTarget: EnvelopeAgent;
    sourceSessionFp: string;
    priority?: EnvelopePriority;
    intent?: string;
    title?: string;
    replyTo?: string | null;
  };
}): Envelope {
  const id = newEnvelopeId();
  return {
    id,
    kind: "inbound",
    target: input.target,
    createdAt: new Date().toISOString(),
    body: input.body,
    workspacePath: input.workspacePath,
    alias: input.alias,
    replyToId: input.replyToId,
    error: input.error === true ? true : undefined,
    chainId: input.codexExtras?.chainId,
    iteration: input.codexExtras?.iteration,
    source: input.codexExtras?.source,
    codexTarget: input.codexExtras?.codexTarget,
    sourceSessionFp: input.codexExtras?.sourceSessionFp,
    priority: input.codexExtras?.priority,
    intent: input.codexExtras?.intent,
    title: input.codexExtras?.title,
    replyTo: input.codexExtras?.replyTo,
  };
}
