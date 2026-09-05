import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomicWrite.mjs";
import { bridgeStateDir } from "../wat321Paths.mjs";

/**
 * Per-target alias bookkeeping for OpenCode and Local LLM sessions.
 * MJS counterpart to `src/shared/bridge/sessionAliases.ts`, which the
 * extension's menus read and write.
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

export const SESSION_ALIASES_PATH = join(bridgeStateDir(), "session-aliases.json");

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
  if (!existsSync(SESSION_ALIASES_PATH)) return emptyAliasMap();
  try {
    const parsed = JSON.parse(readFileSync(SESSION_ALIASES_PATH, "utf8"));
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

/** Atomic so a crash mid-write cannot leave the alias file half-
 * formed. */
export function writeAliases(map) {
  writeFileAtomic(SESSION_ALIASES_PATH, JSON.stringify(map, null, 2));
}

/** The next free `S<n>` alias in a target's bucket. */
function nextAlias(map, target) {
  const taken = Object.keys(map[target] || {});
  let n = 1;
  while (taken.includes(`S${n}`)) n++;
  return `S${n}`;
}

/** Bind a freshly created OpenCode session to the next free alias and
 * make it the active one, so the EH menu's CURRENT row reflects the
 * new session without a manual switch. Reads the map fresh here, after
 * the caller's async create, so a concurrent dispatch's write is not
 * clobbered by a stale snapshot. */
export function bindNewSession(target, sessionId, instanceId) {
  const map = readAliases();
  map[target] = map[target] || {};
  const alias = nextAlias(map, target);
  map[target][alias] = { sessionId, instanceId: instanceId ?? null };
  map.activeAliases = map.activeAliases || { opencode: null, local: null };
  map.activeAliases[target] = alias;
  writeAliases(map);
  return alias;
}
