import type { ResolvedCli } from "../../shared/providers/cliResolver";
import {
  setCodexCatalog,
  type CodexCatalogEntry,
  type CodexModelUpgrade,
} from "../../shared/providers/codex/modelCatalog";
import { writePersistedCatalog } from "../../shared/providers/codex/modelCatalogStore";
import {
  forgetUnlistedPin,
  listUnlistedPins,
} from "../../shared/providers/codex/unlistedModelPins";
import type { AppServerClient } from "../appServer/appServerClient";
import type {
  ModelListEntry,
  ModelListParams,
  ModelListResult,
} from "../appServer/protocol";
import type { EpicHandshakeLogger } from "../epicHandshakeLogger";

/**
 * Bridges the `model/list` RPC into the shared model catalog.
 *
 * Lives in the EH tier because it speaks the app-server protocol. The
 * catalog it fills lives in `shared/` because widgets and pickers read
 * it without knowing the bridge exists. When to ask, and how to ask
 * without a dispatch, is `codexCatalogRefresh.ts`'s job.
 *
 * The whole point is that the app-server describes ITSELF. Anything
 * read from `~/.codex/models_cache.json` may describe a different codex
 * binary entirely, since every codex on the machine overwrites that one
 * file with its own version's catalog.
 *
 * Hidden models are requested on purpose. Codex keeps some models out of
 * its own picker (GPT-6 Astra shipped that way), yet the app-server runs
 * them, so they must count as known or a session pinned to one would be
 * flagged for repair and refused at pre-flight.
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

/** The retirement pointer, when the row carries one. `upgradeInfo` is
 * the richer form and wins over the bare `upgrade` slug. `retirementAt`
 * is epoch seconds on the wire and milliseconds everywhere in WAT321. */
function upgradeFromRpc(entry: ModelListEntry): CodexModelUpgrade | null {
  const info = entry.upgradeInfo ?? null;
  const model = asString(info?.model) ?? asString(entry.upgrade);
  if (model === null) return null;
  const at = info?.retirementAt;
  const retirementAtMs =
    typeof at === "number" && Number.isFinite(at) && at > 0 ? at * 1000 : null;
  return { model, retirementAtMs };
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
    upgrade: upgradeFromRpc(entry),
    hidden: entry.hidden === true,
    isDefault: entry.isDefault === true,
  };
}

/** A typed pin exists only until Codex lists the slug itself. Once the
 * catalog carries it, hidden or not, the catalog vouches for it and the
 * pin would only shadow that answer. */
function forgetPinsNowListed(
  entries: readonly CodexCatalogEntry[],
  logger: EpicHandshakeLogger
): void {
  for (const slug of listUnlistedPins()) {
    if (!entries.some((e) => e.slug === slug)) continue;
    forgetUnlistedPin(slug);
    logger.info(`[catalog] ${slug} is now listed by codex; dropping the typed pin`);
  }
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
  resolved: ResolvedCli | null,
  logger: EpicHandshakeLogger
): Promise<void> {
  const sourceKey = resolved?.command ?? "codex";
  try {
    const entries: CodexCatalogEntry[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MODEL_LIST_MAX_PAGES; page++) {
      const params: ModelListParams = { includeHidden: true };
      if (cursor !== undefined) params.cursor = cursor;
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

    if (entries.length === 0) {
      // An empty answer is a failure mode, not a machine with no models.
      // Whatever was known before stays known, and readers with nothing
      // known keep failing open on the file.
      logger.warn(
        "[catalog] model/list returned no models; keeping the previous answer"
      );
      return;
    }

    const fetchedAt = Date.now();
    setCodexCatalog(entries, fetchedAt);
    forgetPinsNowListed(entries, logger);

    // Persisted under this binary's identity so the next window's picker
    // is truthful before any dispatch has happened. Only written when we
    // know which binary answered - a null resolution cannot be keyed.
    if (resolved !== null) {
      writePersistedCatalog(resolved.command, resolved.version, entries, fetchedAt);
    }

    const dflt = entries.find((e) => e.isDefault)?.slug ?? "none";
    const hidden = entries.filter((e) => e.hidden).length;
    logger.info(
      `[catalog] model/list: ${entries.length} models from ${sourceKey} (default=${dflt}, hidden=${hidden})`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.info(
      `[catalog] model/list unavailable (${msg}); falling back to models_cache.json`
    );
  }
}
