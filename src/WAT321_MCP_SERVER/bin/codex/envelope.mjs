/**
 * Epic Handshake envelope text: YAML frontmatter plus a markdown
 * body. MJS counterpart to the strict parser in
 * `src/WAT321_EPIC_HANDSHAKE/codexTurn/envelope.ts`. The keys here MUST stay in
 * sync with that parser, since the extension host reads every
 * envelope this runtime writes and renaming a key on either side
 * silently strands envelopes in the inbox with no error.
 */

function escapeYaml(v) {
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
  // wait_mode locks the mode the MCP caller asked for into the
  // envelope so the TS dispatcher honors the same mode rather than
  // re-resolving from sticky flag files (which can disagree with the
  // per-call args). Older envelopes without the field fall through
  // to flag-based resolution on the dispatcher side.
  if (fields.waitMode) lines.push(`wait_mode: ${fields.waitMode}`);
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
