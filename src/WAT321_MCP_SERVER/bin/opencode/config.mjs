import { existsSync, readFileSync } from "node:fs";
import { OPENCODE_ROUTES_CONFIG_PATH } from "./common.mjs";

/**
 * Read-only accessors for the per-client OpenCode Routes config the
 * extension writes at activate. The extension is the sole writer;
 * this MCP-side reader trusts whatever it finds and returns sensible
 * fallbacks when the file is absent (OpenCode disabled or first-run).
 */

/** WAT321-managed `opencode serve` URL. Null when OpenCode is
 * disabled or the subprocess hasn't spawned yet. */
export function readServeUrl() {
  if (!existsSync(OPENCODE_ROUTES_CONFIG_PATH)) return null;
  try {
    const cfg = JSON.parse(readFileSync(OPENCODE_ROUTES_CONFIG_PATH, "utf8"));
    const url = cfg?.openCodeServerUrl;
    return typeof url === "string" && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/** Tool-use hint toggle. True when dispatch.mjs should prepend the
 * webfetch-bias hint to ask prompts. Defaults true on missing config
 * or parse error so the bridge biases toward tool-use even before the
 * extension first writes config. */
export function readToolUseHint() {
  if (!existsSync(OPENCODE_ROUTES_CONFIG_PATH)) return true;
  try {
    const cfg = JSON.parse(readFileSync(OPENCODE_ROUTES_CONFIG_PATH, "utf8"));
    return cfg?.toolUseHint !== false;
  } catch {
    return true;
  }
}

/** Configured catalog (model id, kind, retention) snapshot. */
export function readInstances() {
  if (!existsSync(OPENCODE_ROUTES_CONFIG_PATH)) return [];
  try {
    const cfg = JSON.parse(readFileSync(OPENCODE_ROUTES_CONFIG_PATH, "utf8"));
    return Array.isArray(cfg?.instances) ? cfg.instances : [];
  } catch {
    return [];
  }
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
  const instances = readInstances();
  if (!id) {
    if (!existsSync(OPENCODE_ROUTES_CONFIG_PATH)) {
      return instances.find((i) => kind === null || i.kind === kind) || null;
    }
    try {
      const cfg = JSON.parse(readFileSync(OPENCODE_ROUTES_CONFIG_PATH, "utf8"));
      const activeId = typeof cfg?.activeInstanceId === "string" ? cfg.activeInstanceId : null;
      if (activeId) {
        const active = instances.find((i) => i.id === activeId);
        if (active && (kind === null || active.kind === kind)) return active;
      }
      return instances.find((i) => kind === null || i.kind === kind) || null;
    } catch {
      return instances.find((i) => kind === null || i.kind === kind) || null;
    }
  }
  return instances.find((i) => i.id === id) || null;
}
