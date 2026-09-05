import { errorResult } from "./mcpResults.mjs";
import { readCatalog, readLastUsedInstance } from "./routesConfig.mjs";

/**
 * Bridge router. Resolves a free-form alias string ("Big Pickle",
 * "Codex", "Pickle" via fuzzy match) to a concrete dispatch target +
 * optional instance_id. Catalog-driven, deterministic, no LLM in the
 * loop: adding a new instance is a catalog edit and the router gets
 * it for free, so Claude never needs to know the target enum or the
 * backend URLs exist.
 *
 * Resolution order:
 *   1. Exact target keyword: "codex" / "opencode" / "local" (case-
 *      insensitive). Returns just `{target}` so the dispatch handler
 *      can pick the active instance for that target.
 *   2. Exact alias / id match against the catalog.
 *   3. Substring fuzzy match. Single hit returns it, multiple hits
 *      return `{ambiguous, candidates}` for Claude to disambiguate.
 *   4. Empty / null alias -> `{useDefault: true}` so the caller
 *      falls back to last-used, then active, then Codex.
 */

const TARGET_KEYWORDS = new Map([
  ["codex", "codex"],
  ["opencode", "opencode"],
  ["local", "local"],
  ["local llm", "local"],
  ["local-llm", "local"],
]);

function instanceKindToTarget(kind) {
  return kind === "local" ? "local" : "opencode";
}

function makeRouter() {
  const catalog = readCatalog();
  function resolve(alias) {
    if (alias === null || alias === undefined) {
      return { useDefault: true };
    }
    const norm = String(alias).trim().toLowerCase();
    if (norm.length === 0) return { useDefault: true };
    if (TARGET_KEYWORDS.has(norm)) {
      return { target: TARGET_KEYWORDS.get(norm) };
    }
    for (const inst of catalog.instances) {
      const a = String(inst.alias || "").toLowerCase();
      const id = String(inst.id || "").toLowerCase();
      if (a === norm || id === norm) {
        return { target: instanceKindToTarget(inst.kind), instance_id: inst.id };
      }
    }
    // Substring fuzzy match. Bias toward alias matches over id matches
    // (alias is what the user typed, id is the internal slug).
    const candidates = catalog.instances.filter((inst) => {
      const a = String(inst.alias || "").toLowerCase();
      const id = String(inst.id || "").toLowerCase();
      return a.includes(norm) || id.includes(norm);
    });
    if (candidates.length === 1) {
      const inst = candidates[0];
      return { target: instanceKindToTarget(inst.kind), instance_id: inst.id };
    }
    if (candidates.length > 1) {
      return {
        ambiguous: true,
        candidates: candidates.map((c) => c.alias || c.id),
      };
    }
    return { unknown: true, alias };
  }
  return { resolve, catalog };
}

/** Resolve a wat321_ask call's target via the router. Returns either
 * `{ target, instance_id? }` for dispatch, or `{ error }` holding an
 * MCP error result suitable for direct return. Backward-compat: still
 * accepts an explicit `target` arg if the caller bypasses the alias
 * surface. */
export function resolveAskTarget(args, enabled) {
  const router = makeRouter();
  const explicitTarget = typeof args?.target === "string" ? args.target : null;
  const explicitInstance =
    typeof args?.instance_id === "string" ? args.instance_id : null;
  const alias = typeof args?.alias === "string" ? args.alias : null;

  if (explicitTarget !== null) {
    return {
      target: explicitTarget,
      instance_id: explicitInstance ?? undefined,
    };
  }

  const resolved = router.resolve(alias);
  if (resolved.ambiguous) {
    return {
      error: errorResult(
        `Alias '${alias}' is ambiguous - matched: ${resolved.candidates.join(", ")}. Be more specific.`
      ),
    };
  }
  if (resolved.unknown) {
    return {
      error: errorResult(
        `Alias '${resolved.alias}' is not a known backend. Read the bridge://instances resource for available aliases, or use a known target keyword (Codex / OpenCode / Local LLM).`
      ),
    };
  }
  if (!resolved.useDefault) {
    return { target: resolved.target, instance_id: resolved.instance_id };
  }

  // Default-route resolution: prefer the OpenCode Routes last-used
  // sidecar, then the active-instance preference, then Codex when
  // enabled. Mirrors what the widget shows so a default-aliased
  // call lands on whatever the user has been using most recently.
  //
  // Every candidate is gated on its target being ENABLED. A default
  // route must never land somewhere the user has switched off: the
  // dispatch handler would reject it with "target is not enabled",
  // which reads as a broken bridge rather than as "you did not say
  // where to send this". An explicit alias naming a disabled target
  // still errors, and should. That is the user asking for something
  // unavailable, not us guessing wrong.
  const usable = (inst) =>
    inst !== undefined && enabled[instanceKindToTarget(inst.kind)];

  const lastUsed = readLastUsedInstance();
  if (lastUsed?.instanceId) {
    const inst = router.catalog.instances.find((i) => i.id === lastUsed.instanceId);
    if (usable(inst)) {
      return { target: instanceKindToTarget(inst.kind), instance_id: inst.id };
    }
  }
  if (router.catalog.activeInstanceId) {
    const inst = router.catalog.instances.find(
      (i) => i.id === router.catalog.activeInstanceId
    );
    if (usable(inst)) {
      return { target: instanceKindToTarget(inst.kind), instance_id: inst.id };
    }
  }
  if (enabled.codex) return { target: "codex" };
  return {
    error: errorResult(
      "No alias passed and no default could be resolved. Pass alias='Codex' / 'Big Pickle' / etc., or set an active instance via the WAT321 widget."
    ),
  };
}
