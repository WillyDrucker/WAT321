import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { ALIAS_PATH, ensureDir } from "./common.mjs";

/**
 * Per-target alias bookkeeping for OpenCode and Local LLM sessions.
 *
 * On-disk shape: `{opencode: {S1: {sessionId, instanceId}, ...},
 * local: {...}, activeAliases: {opencode: 'S1' | null, local: ...}}`.
 *
 * Alias entries store both the OpenCode session id (the routing key)
 * and the catalog instanceId the session was bound to at create time.
 * The bound instanceId pins the displayed model to what the session
 * was actually created against, even after the user's active-instance
 * preference drifts.
 *
 * Legacy entries stored a bare session-id string. Read normalizes
 * them to `{sessionId, instanceId: null}` so an upgrade does not
 * orphan a user's existing sessions.
 */

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

export function readAliases() {
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

/** Atomic tmp+rename so a crash mid-write cannot leave the alias
 * file half-formed. Single-writer (only this MCP server process). */
export function writeAliases(map) {
  ensureDir();
  const tmp = `${ALIAS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2));
  renameSync(tmp, ALIAS_PATH);
}

/** Pick the next free `S<n>` alias for a target. */
export function nextAlias(target) {
  const map = readAliases();
  const taken = Object.keys(map[target] || {});
  let n = 1;
  while (taken.includes(`S${n}`)) n++;
  return `S${n}`;
}
