import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./channelLog.mjs";
import { openCodeRoutesStateDir } from "./wat321Paths.mjs";

/**
 * Read-only accessors for the per-client OpenCode Routes config the
 * extension writes at activate and on every settings change. The
 * extension is the sole writer. This reader trusts whatever it finds
 * and returns empty fallbacks when the file is absent (OpenCode
 * disabled or first run). MJS counterpart to
 * `src/shared/bridge/openCodeRoutesConfigSnapshot.ts`.
 */

export const OPENCODE_ROUTES_CONFIG_PATH = join(openCodeRoutesStateDir(), "config.json");
/** Sidecar the heartbeat writer persists on successful dispatch so
 * the widget and the default route keep pointing at the backend the
 * user actually used last. */
export const OPENCODE_LAST_USED_PATH = join(openCodeRoutesStateDir(), "last-used.json");

function readRoutesConfig() {
  try {
    if (!existsSync(OPENCODE_ROUTES_CONFIG_PATH)) return null;
    return JSON.parse(readFileSync(OPENCODE_ROUTES_CONFIG_PATH, "utf8"));
  } catch (err) {
    log("warn", `routes config unreadable: ${err?.message || String(err)}`);
    return null;
  }
}

/** WAT321-managed `opencode serve` URL. Null when OpenCode is
 * disabled or the subprocess has not spawned yet. */
export function readServeUrl() {
  const url = readRoutesConfig()?.openCodeServerUrl;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/** Configured catalog (model id, kind, retention) snapshot. */
export function readInstances() {
  const instances = readRoutesConfig()?.instances;
  return Array.isArray(instances) ? instances : [];
}

/** Catalog plus the user's active-instance preference, for the alias
 * router and the `bridge://instances` resource. */
export function readCatalog() {
  const cfg = readRoutesConfig();
  return {
    instances: Array.isArray(cfg?.instances) ? cfg.instances : [],
    activeInstanceId:
      typeof cfg?.activeInstanceId === "string" ? cfg.activeInstanceId : null,
  };
}

/** Resolve a catalog instance by id, with an optional target-kind
 * filter on the active-instance fallback.
 *
 * Without the kind filter, an opencode session would inherit a
 * local-kind active instance when activeInstanceId points there,
 * binding the session to Local LLM by mistake. Pass kind="remote"
 * or "local" to skip a mismatched active and fall back to a
 * target-kind-matching entry. Explicit `id` lookups bypass the
 * filter (the caller asked for a specific instance). */
export function findInstance(id, kind = null) {
  const { instances, activeInstanceId } = readCatalog();
  if (id) return instances.find((i) => i.id === id) || null;
  const matchesKind = (i) => kind === null || i.kind === kind;
  if (activeInstanceId) {
    const active = instances.find((i) => i.id === activeInstanceId);
    if (active && matchesKind(active)) return active;
  }
  return instances.find(matchesKind) || null;
}

/** Best-effort read of the last-used sidecar. */
export function readLastUsedInstance() {
  try {
    if (!existsSync(OPENCODE_LAST_USED_PATH)) return null;
    return JSON.parse(readFileSync(OPENCODE_LAST_USED_PATH, "utf8"));
  } catch {
    return null;
  }
}
