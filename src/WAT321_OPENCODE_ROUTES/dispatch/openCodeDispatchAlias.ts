import { readAliases, SESSION_ALIASES_PATH } from "../../shared/bridge/sessionAliases";

/**
 * Session-alias resolution for the OpenCode / Local LLM dispatcher.
 * Reads `<bridgeStateDir()>/session-aliases.json`, the alias map the
 * MCP runtime's `WAT321_MCP_SERVER/bin/opencode/sessionAliases.mjs`
 * writes. Reading anywhere else means the dispatcher won't see
 * sessions just created via `wat321_session`.
 */

/** Resolve the session alias the dispatcher should target. Explicit
 * `sessionAlias` on the envelope wins - otherwise read the active
 * alias from disk. Returns null when no session is configured
 * (one-shot path). The envelope's `sessionAlias` is populated from
 * the caller's `session` arg on `wat321_ask` so a caller can target
 * a specific session even when the active is something else. */
export function readActiveAlias(
  target: "opencode" | "local",
  env: { sessionAlias?: string }
): string | null {
  if (typeof env.sessionAlias === "string" && env.sessionAlias.length > 0) {
    return env.sessionAlias;
  }
  const map = readAliases(SESSION_ALIASES_PATH);
  const active = map.activeAliases?.[target];
  if (typeof active === "string" && active.length > 0) return active;
  return null;
}
