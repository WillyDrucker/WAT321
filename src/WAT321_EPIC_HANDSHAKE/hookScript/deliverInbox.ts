/**
 * WAT321 Epic Handshake - UserPromptSubmit hook script.
 *
 * Lives at `~/.wat321/epic-handshake/hooks/deliverInbox.js` at runtime.
 * Installed by `hookInstaller.ts` from the compiled output of this file
 * in `out/WAT321_EPIC_HANDSHAKE/hookScript/deliverInbox.js`.
 *
 * Registered in `~/.claude/settings.json` under `hooks.UserPromptSubmit`.
 * Claude Code's binary fires this script on every user prompt submit,
 * pipes the event JSON to stdin, and merges `additionalContext` stdout
 * into the model's next-turn context.
 *
 * Design invariants:
 *
 *   - SELF-CONTAINED. Does not import from the rest of the extension.
 *     Runs as a standalone Node script in the user's HOME namespace
 *     without access to anything else in `out/`. The frontmatter parser
 *     is re-implemented inline (duplicated from `messageFormat.ts`)
 *     for exactly this reason.
 *
 *   - NEVER THROWS. Every error path still exits 0 with no output so
 *     Claude Code's prompt flow is never blocked by a Bridge failure.
 *     A missing inbox directory, an empty inbox, a malformed message,
 *     or any other edge case produces a silent no-op.
 *
 *   - NO DEPENDENCIES beyond `node:` builtins. Zero-runtime-deps is a
 *     WAT321 project-wide guarantee.
 *
 *   - NO IMPORTS FROM `vscode`. This is a plain Node script, not a
 *     VS Code extension module.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const INBOX_DIR = join(
  homedir(),
  ".wat321",
  "epic-handshake",
  "inbox",
  "claude"
);
const SENT_DIR = join(
  homedir(),
  ".wat321",
  "epic-handshake",
  "sent",
  "claude"
);

interface InlineEnvelope {
  id: string;
  from: string;
  to: string;
  intent: string;
  title: string;
  createdAt: string;
  replyTo: string | null;
  attachments: string[];
  body: string;
}

async function main(): Promise<void> {
  try {
    await drainStdin();
  } catch {
    // best-effort
  }

  if (!existsSync(INBOX_DIR)) return;

  let files: string[];
  try {
    files = readdirSync(INBOX_DIR)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => join(INBOX_DIR, name));
  } catch {
    return;
  }

  if (files.length === 0) return;

  const parsed: { path: string; envelope: InlineEnvelope }[] = [];
  for (const path of files) {
    const envelope = tryParseEnvelope(path);
    if (envelope !== null) parsed.push({ path, envelope });
  }
  if (parsed.length === 0) return;

  const content = formatAsSystemReminder(parsed.map((p) => p.envelope));

  // Emit the JSON contract understood by Claude Code's hook system.
  // `additionalContext` is merged into the current turn's context as a
  // system-reminder visible to the model.
  process.stdout.write(JSON.stringify({ additionalContext: content }));

  // Move delivered files out of the inbox so they do not re-deliver.
  // Failure to move a single file is best-effort. Better to re-deliver
  // a message once than to lose one.
  try {
    if (!existsSync(SENT_DIR)) mkdirSync(SENT_DIR, { recursive: true });
  } catch {
    // best-effort
  }
  for (const { path } of parsed) {
    try {
      renameSync(path, join(SENT_DIR, basename(path)));
    } catch {
      // best-effort
    }
  }
}

function drainStdin(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    try {
      process.stdin.on("data", () => {});
      process.stdin.on("end", finish);
      process.stdin.on("error", finish);
      if (process.stdin.readable === false) finish();
      setTimeout(finish, 500).unref?.();
    } catch {
      finish();
    }
  });
}

function tryParseEnvelope(path: string): InlineEnvelope | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return parseEnvelopeInline(text);
  } catch {
    return null;
  }
}

/** Minimal inline frontmatter parser. Mirrors the full parser in
 * `src/WAT321_EPIC_HANDSHAKE/messageFormat.ts` but deliberately
 * duplicated here so this hook script stays self-contained with zero
 * imports from the rest of the extension. */
function parseEnvelopeInline(text: string): InlineEnvelope {
  const lines = text.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") {
    throw new Error("missing leading separator");
  }
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) throw new Error("missing closing separator");

  const fm: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;
  let currentArray: string[] | null = null;

  for (let i = 1; i < closeIndex; i++) {
    const raw = lines[i];
    if (raw === "") continue;
    if (raw.startsWith("  - ")) {
      if (currentArray === null) throw new Error("orphan array item");
      currentArray.push(raw.substring(4).trim());
      continue;
    }
    if (currentArrayKey !== null && currentArray !== null) {
      fm[currentArrayKey] = currentArray;
      currentArrayKey = null;
      currentArray = null;
    }
    const colonIndex = raw.indexOf(":");
    if (colonIndex === -1) throw new Error(`line missing colon: ${raw}`);
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
  while (bodyLines.length > 0 && bodyLines[0] === "") bodyLines.shift();
  const body = bodyLines.join("\n").replace(/\s+$/, "");

  if (typeof fm.id !== "string") throw new Error("missing id");
  if (typeof fm.from !== "string") throw new Error("missing from");
  if (typeof fm.to !== "string") throw new Error("missing to");
  if (typeof fm.intent !== "string") throw new Error("missing intent");
  if (typeof fm.title !== "string") throw new Error("missing title");
  if (typeof fm.created_at !== "string") throw new Error("missing created_at");

  const replyToRaw = fm.reply_to;
  const replyTo =
    replyToRaw === null || replyToRaw === undefined
      ? null
      : typeof replyToRaw === "string"
        ? replyToRaw
        : null;

  const attachments = Array.isArray(fm.attachments)
    ? (fm.attachments as string[]).filter((x) => typeof x === "string")
    : [];

  return {
    id: fm.id,
    from: fm.from,
    to: fm.to,
    intent: fm.intent,
    title: fm.title,
    createdAt: fm.created_at,
    replyTo,
    attachments,
    body,
  };
}

function formatAsSystemReminder(envelopes: InlineEnvelope[]): string {
  const lines: string[] = [];
  const plural = envelopes.length === 1 ? "message" : "messages";
  lines.push(`Epic Handshake: ${envelopes.length} new ${plural} from Codex`);
  lines.push("");

  for (const e of envelopes) {
    lines.push("---");
    lines.push(`From: ${e.from}`);
    lines.push(`Intent: ${e.intent}`);
    lines.push(`Title: ${e.title}`);
    if (e.replyTo !== null) {
      lines.push(`Reply to: ${e.replyTo}`);
    }
    if (e.attachments.length > 0) {
      lines.push(`Attachments: ${e.attachments.join(", ")}`);
    }
    lines.push("");
    lines.push(e.body);
    lines.push("");
  }

  return lines.join("\n");
}

main().catch(() => {
  // Absolute last-resort catch. Hook must never block Claude's flow.
});
