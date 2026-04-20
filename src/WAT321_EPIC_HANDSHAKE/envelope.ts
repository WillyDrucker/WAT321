import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Envelope format for Epic Handshake messages passed between agents
 * via the filesystem mailbox. Shape matches exactly what
 * `bin/channel.mjs` writes, so both sides stay in sync.
 *
 * YAML frontmatter + markdown body, atomic tmp+rename on write.
 * Hand-rolled serializer keeps the module dependency-free.
 */

export type EnvelopeAgent = "claude" | "codex";

export interface Envelope {
  id: string;
  chainId: string;
  iteration: number;
  source: EnvelopeAgent;
  target: EnvelopeAgent;
  sourceSessionFp: string;
  priority: "low" | "normal" | "high";
  intent: string;
  workspacePath: string;
  createdAt: string;
  replyTo: string | null;
  title?: string;
  body: string;
}

export function newEnvelopeId(): string {
  return randomUUID();
}

function esc(v: string): string {
  if (/[:#\n]/.test(v)) return JSON.stringify(v);
  return v;
}

export function serializeEnvelope(env: Envelope): string {
  const lines: string[] = ["---"];
  lines.push(`id: ${env.id}`);
  lines.push(`chain_id: ${env.chainId}`);
  lines.push(`iteration: ${env.iteration}`);
  lines.push(`source: ${env.source}`);
  lines.push(`target: ${env.target}`);
  lines.push(`source_session_fp: ${env.sourceSessionFp}`);
  lines.push(`priority: ${env.priority}`);
  lines.push(`intent: ${env.intent}`);
  lines.push(`workspace_path: ${env.workspacePath}`);
  lines.push(`created_at: ${env.createdAt}`);
  lines.push(`reply_to: ${env.replyTo === null ? "null" : env.replyTo}`);
  if (env.title) lines.push(`title: ${esc(env.title)}`);
  lines.push("---");
  lines.push("");
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

  const required = [
    "id",
    "chain_id",
    "iteration",
    "source",
    "target",
    "source_session_fp",
    "priority",
    "intent",
    "workspace_path",
    "created_at",
  ];
  for (const k of required) {
    if (fields[k] === undefined || fields[k] === null) return null;
  }

  return {
    id: fields.id as string,
    chainId: fields.chain_id as string,
    iteration: Number(fields.iteration ?? "0"),
    source: fields.source as EnvelopeAgent,
    target: fields.target as EnvelopeAgent,
    sourceSessionFp: fields.source_session_fp as string,
    priority: (fields.priority as "low" | "normal" | "high") ?? "normal",
    intent: fields.intent as string,
    workspacePath: fields.workspace_path as string,
    createdAt: fields.created_at as string,
    replyTo: fields.reply_to,
    title: (fields.title as string) || undefined,
    body,
  };
}

export function writeEnvelopeAtomic(path: string, env: Envelope): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serializeEnvelope(env), "utf8");
  renameSync(tmp, path);
}

export function readEnvelope(path: string): Envelope | null {
  try {
    const raw = readFileSync(path, "utf8");
    return parseEnvelope(raw);
  } catch {
    return null;
  }
}
