import {
  setCodexCatalog,
  type CodexCatalogEntry,
} from "../shared/providers/codex/modelCatalog";
import type { AppServerClient } from "./appServerClient";
import type {
  ModelListEntry,
  ModelListParams,
  ModelListResult,
} from "./protocol";
import type { EpicHandshakeLogger } from "./types";

/**
 * Bridges the `model/list` RPC into the shared model catalog.
 *
 * Lives in the EH tier because it speaks the app-server protocol. The
 * catalog it fills lives in `shared/` because widgets and pickers read
 * it without knowing the bridge exists.
 *
 * The whole point is that the app-server describes ITSELF. Anything
 * read from `~/.codex/models_cache.json` may describe a different codex
 * binary entirely, since every codex on the machine overwrites that one
 * file with its own version's catalog.
 */

/** Bounded so an app-server that always returns a cursor cannot spin.
 * Every version observed returns its full set on page one. */
const MODEL_LIST_MAX_PAGES = 10;

/** Short on purpose. This is a background nicety, never on the turn
 * path, and a hung call must not keep a promise alive behind the
 * dispatcher's back. */
const MODEL_LIST_TIMEOUT_MS = 10_000;

/** Narrow an untyped field to a non-empty string. The `model/list`
 * payload reaches us through an unchecked cast, so every field it
 * supplies is validated here rather than trusted. A row carrying
 * `displayName: 123` would otherwise reach `.toUpperCase()` in the model
 * picker and throw at render time, far from its cause. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Map one RPC row onto a catalog row. Returns null for a row with no
 * usable id, the only field we cannot synthesize.
 *
 * Note every field is renamed relative to `models_cache.json`. See the
 * warning on `ModelListEntry` in `protocol.ts` before touching this. */
function toCatalogEntry(entry: ModelListEntry): CodexCatalogEntry | null {
  if (typeof entry !== "object" || entry === null) return null;
  const slug = asString(entry.id) ?? asString(entry.model);
  if (slug === null) return null;

  // A single malformed effort row must not abort the whole sync and cost
  // us the catalog, so each is filtered rather than assumed well-formed.
  const efforts: { effort: string; description: string }[] = [];
  const advertised = entry.supportedReasoningEfforts;
  if (Array.isArray(advertised)) {
    for (const level of advertised) {
      if (typeof level !== "object" || level === null) continue;
      const effort = asString(level.reasoningEffort);
      if (effort === null) continue;
      efforts.push({ effort, description: asString(level.description) ?? "" });
    }
  }

  return {
    slug,
    displayName: asString(entry.displayName) ?? slug,
    description: asString(entry.description) ?? "",
    defaultEffort: asString(entry.defaultReasoningEffort),
    supportedEfforts: efforts,
    hidden: entry.hidden === true,
    isDefault: entry.isDefault === true,
  };
}

/**
 * Ask an already-initialized app-server for its model list and publish
 * it to the shared catalog.
 *
 * Never throws. Never spawns anything. Never touches the dispatcher's
 * idle timer, so the app-server's warm / cold lifetime is untouched.
 *
 * On any failure (a codex too old to know `model/list`, transport
 * error, timeout) the catalog is left as it was and every reader falls
 * back to `models_cache.json`, failing open. That is precisely the
 * behavior WAT321 shipped before this module existed, which is what
 * makes an unreachable RPC a no-op rather than a regression for users
 * upgrading from an older WAT321 or running an older Codex.
 */
export async function syncCodexCatalog(
  client: AppServerClient,
  sourceKey: string,
  logger: EpicHandshakeLogger
): Promise<void> {
  try {
    const entries: CodexCatalogEntry[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MODEL_LIST_MAX_PAGES; page++) {
      const params: ModelListParams = cursor === undefined ? {} : { cursor };
      const raw = await client.sendRequest(
        "model/list",
        params,
        MODEL_LIST_TIMEOUT_MS
      );
      const result = raw as ModelListResult | undefined;
      if (!result || !Array.isArray(result.data)) break;

      for (const row of result.data) {
        const mapped = toCatalogEntry(row);
        if (mapped !== null) entries.push(mapped);
      }

      const next = result.nextCursor;
      if (typeof next !== "string" || next.length === 0) break;
      cursor = next;
    }

    // `setCodexCatalog` is the gate: an empty list is a failure mode, not
    // a machine with no models, and it leaves readers on the file with
    // validity failing open. Publish unconditionally and let it decide.
    setCodexCatalog(entries);

    if (entries.length === 0) {
      logger.warn("[catalog] model/list returned no models; keeping file fallback");
      return;
    }
    const dflt = entries.find((e) => e.isDefault)?.slug ?? "none";
    logger.info(
      `[catalog] model/list: ${entries.length} models from ${sourceKey} (default=${dflt})`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.info(
      `[catalog] model/list unavailable (${msg}); falling back to models_cache.json`
    );
  }
}
