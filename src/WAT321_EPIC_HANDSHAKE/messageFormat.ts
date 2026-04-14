import type { AgentId, MessageEnvelope, MessageIntent } from "./types";

/**
 * Minimal YAML frontmatter parser and serializer for Epic Handshake
 * message envelopes. Our schema is small and flat (seven scalar
 * fields plus one string array) so we hand-roll the format instead
 * of pulling in a YAML dependency. This keeps WAT321's zero-runtime-
 * deps guarantee intact.
 *
 * Supported frontmatter shapes:
 *
 *     key: value           (single-line scalar)
 *     key: null            (explicit null, only for `reply_to`)
 *     key:                 (multi-line array header)
 *       - item-one
 *       - item-two
 *     key: []              (inline empty array)
 *
 * Anything not matching these patterns is rejected with a
 * `MessageFormatError`. Envelopes are produced by WAT321-controlled
 * writers (send skill, `writeMessage`) so the parser is deliberately
 * strict.
 */

const FRONTMATTER_SEPARATOR = "---";

const VALID_AGENTS: ReadonlySet<AgentId> = new Set(["claude", "codex"]);

const VALID_INTENTS: ReadonlySet<MessageIntent> = new Set([
  "question",
  "review",
  "handoff",
  "decision",
  "reply",
]);

/** Thrown by `parseEnvelope` on any malformed frontmatter input. */
export class MessageFormatError extends Error {
  constructor(message: string) {
    super(`Epic Handshake message format error: ${message}`);
    this.name = "MessageFormatError";
  }
}

/** Serialize a MessageEnvelope to markdown text (frontmatter + body).
 * Always ends with a trailing newline so the atomic writer leaves a
 * cleanly terminated file on disk. */
export function serializeEnvelope(envelope: MessageEnvelope): string {
  const lines: string[] = [];
  lines.push(FRONTMATTER_SEPARATOR);
  lines.push(`id: ${envelope.id}`);
  lines.push(`from: ${envelope.from}`);
  lines.push(`to: ${envelope.to}`);
  lines.push(`intent: ${envelope.intent}`);
  lines.push(`title: ${envelope.title}`);
  lines.push(`created_at: ${envelope.createdAt}`);
  lines.push(
    `reply_to: ${envelope.replyTo === null ? "null" : envelope.replyTo}`
  );
  if (envelope.attachments.length === 0) {
    lines.push("attachments: []");
  } else {
    lines.push("attachments:");
    for (const att of envelope.attachments) {
      lines.push(`  - ${att}`);
    }
  }
  lines.push(FRONTMATTER_SEPARATOR);
  lines.push("");
  lines.push(envelope.body.trimEnd());
  lines.push("");
  return lines.join("\n");
}

/** Parse markdown text into a `MessageEnvelope`. Throws
 * `MessageFormatError` on any failure mode: missing separators,
 * unknown keys, malformed values, invalid enum values, unrecognized
 * array structure. */
export function parseEnvelope(text: string): MessageEnvelope {
  const lines = text.split("\n");
  if (lines.length === 0 || lines[0].trim() !== FRONTMATTER_SEPARATOR) {
    throw new MessageFormatError("missing leading frontmatter separator");
  }

  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FRONTMATTER_SEPARATOR) {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    throw new MessageFormatError("missing closing frontmatter separator");
  }

  const fm: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;
  let currentArray: string[] | null = null;

  for (let i = 1; i < closeIndex; i++) {
    const raw = lines[i];
    if (raw === "") continue;

    if (raw.startsWith("  - ")) {
      if (currentArray === null) {
        throw new MessageFormatError(
          `array item without array header: ${raw}`
        );
      }
      currentArray.push(raw.substring(4).trim());
      continue;
    }

    if (currentArrayKey !== null && currentArray !== null) {
      fm[currentArrayKey] = currentArray;
      currentArrayKey = null;
      currentArray = null;
    }

    const colonIndex = raw.indexOf(":");
    if (colonIndex === -1) {
      throw new MessageFormatError(`line missing colon: ${raw}`);
    }
    const key = raw.substring(0, colonIndex).trim();
    const value = raw.substring(colonIndex + 1).trim();

    if (value === "") {
      currentArrayKey = key;
      currentArray = [];
    } else if (value === "[]") {
      fm[key] = [];
    } else if (value === "null") {
      fm[key] = null;
    } else {
      fm[key] = value;
    }
  }

  if (currentArrayKey !== null && currentArray !== null) {
    fm[currentArrayKey] = currentArray;
  }

  const bodyLines = lines.slice(closeIndex + 1);
  while (bodyLines.length > 0 && bodyLines[0] === "") {
    bodyLines.shift();
  }
  const body = bodyLines.join("\n").trimEnd();

  return {
    id: requireString(fm, "id"),
    from: requireAgent(fm, "from"),
    to: requireAgent(fm, "to"),
    intent: requireIntent(fm, "intent"),
    title: requireString(fm, "title"),
    createdAt: requireString(fm, "created_at"),
    replyTo: requireNullableString(fm, "reply_to"),
    attachments: requireStringArray(fm, "attachments"),
    body,
  };
}

function requireString(fm: Record<string, unknown>, key: string): string {
  const v = fm[key];
  if (typeof v !== "string" || v === "") {
    throw new MessageFormatError(`missing or invalid ${key}`);
  }
  return v;
}

function requireNullableString(
  fm: Record<string, unknown>,
  key: string
): string | null {
  const v = fm[key];
  if (v === null) return null;
  if (typeof v === "string" && v !== "") return v;
  throw new MessageFormatError(`missing or invalid ${key}`);
}

function requireAgent(fm: Record<string, unknown>, key: string): AgentId {
  const v = fm[key];
  if (typeof v === "string" && VALID_AGENTS.has(v as AgentId)) {
    return v as AgentId;
  }
  throw new MessageFormatError(`missing or invalid ${key}: ${String(v)}`);
}

function requireIntent(
  fm: Record<string, unknown>,
  key: string
): MessageIntent {
  const v = fm[key];
  if (typeof v === "string" && VALID_INTENTS.has(v as MessageIntent)) {
    return v as MessageIntent;
  }
  throw new MessageFormatError(`missing or invalid ${key}: ${String(v)}`);
}

function requireStringArray(
  fm: Record<string, unknown>,
  key: string
): string[] {
  const v = fm[key];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return v as string[];
  }
  throw new MessageFormatError(`missing or invalid ${key}`);
}
