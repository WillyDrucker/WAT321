import {
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Envelope ser/de for the Epic Handshake bridge. Hand-rolled YAML
 * frontmatter (no deps) plus a body. The same shape is read by the
 * dispatcher TS-side; both ends must agree on field names and the
 * `---\n...\n---\n\n<body>` framing.
 */

export function escapeYaml(v) {
  if (/[:#\n]/.test(v)) return JSON.stringify(v);
  return v;
}

export function buildEnvelope(fields) {
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

export function parseEnvelope(raw) {
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

/** Atomic tmp+rename writer. Recreates the parent dir first because
 * Reset WAT321 wipes ~/.wat321/ and a sibling Claude session can hit
 * a missing inbox subdir on first dispatch from a never-before-seen
 * workspace. */
export function writeAtomic(path, content) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}
