import { resolveCodexCli } from "../../shared/providers/codex/cliResolver";
import {
  codexCatalogAgeMs,
  setCodexCatalog,
} from "../../shared/providers/codex/modelCatalog";
import { readPersistedCatalog } from "../../shared/providers/codex/modelCatalogStore";
import { spawnInitializedAppServer } from "../appServer/appServerBootstrap";
import type { AppServerClient } from "../appServer/appServerClient";
import { syncCodexCatalog } from "./codexCatalogSync";
import type { EpicHandshakeLogger } from "../epicHandshakeLogger";

/**
 * When to ask Codex for its model list again, and how to ask without a
 * dispatch. `codexCatalogSync.ts` owns the RPC mapping, this file owns
 * the freshness policy around it.
 *
 * An answer ages. The backend decides per account which models a
 * binary may list and can switch one on with no upgrade (GPT-6 Astra
 * arrived as a staged rollout), so `ensureCodexCatalog` re-asks once
 * the answer is old and `refreshCodexCatalog` re-asks on demand.
 *
 * `hydrateCodexCatalog` spawns nothing. It only reads a sidecar this
 * same binary wrote on a previous run, so a freshly opened window shows
 * a truthful model picker without paying a cold start and without
 * breaking the tier's "no activate-time codex daemon spawn" rule.
 */

/** How long an answer stays fresh before a picker asks again. Ten
 * minutes keeps a user who reopens the picker a few times from paying a
 * spawn each time, while a model switched on for the account shows up
 * on the next open after that. Codex's own picker re-asks on every
 * open. Dispatches re-ask on every cold spawn regardless of age. */
const CATALOG_FRESH_FOR_MS = 10 * 60 * 1000;

/**
 * Fill the catalog from the sidecar this binary wrote on a previous run.
 *
 * Resolves the Codex CLI (a cached `--version` probe) and loads the
 * sidecar only when both the command and the exact version line match,
 * so an upgraded, downgraded, or swapped binary is a miss rather than a
 * lie. A miss is a silent no-op: the catalog stays as it was, readers
 * fall back to `~/.codex/models_cache.json`, and validity keeps failing
 * open. The first real dispatch replaces whatever this loaded.
 */
export async function hydrateCodexCatalog(
  logger: EpicHandshakeLogger
): Promise<void> {
  try {
    const resolved = await resolveCodexCli();
    if (resolved === null) return;
    const persisted = readPersistedCatalog(resolved.command, resolved.version);
    if (persisted === null) return;
    // Never replace a fresher answer already in memory. The sidecar lags
    // memory when a write failed, and a sibling window's newer sidecar
    // is the only case worth adopting over what this window already has.
    const memoryAgeMs = codexCatalogAgeMs();
    const sidecarAgeMs =
      persisted.fetchedAt > 0
        ? Math.max(0, Date.now() - persisted.fetchedAt)
        : Number.POSITIVE_INFINITY;
    if (Number.isFinite(memoryAgeMs) && sidecarAgeMs >= memoryAgeMs) return;
    setCodexCatalog(persisted.entries, persisted.fetchedAt);
    logger.info(
      `[catalog] hydrated ${persisted.entries.length} models from sidecar for ${resolved.version}`
    );
  } catch {
    // best-effort
  }
}

/**
 * Guarantee a fresh catalog before showing the user a list of models,
 * without ever asking them to run a command first.
 *
 * Three tiers, cheapest first:
 *   1. Already in memory and younger than `CATALOG_FRESH_FOR_MS`.
 *   2. The sidecar this same binary wrote on a previous run, when it is
 *      younger than memory and fresh. No process.
 *   3. A short-lived app-server, spawned only to answer `model/list` and
 *      shut down immediately. About two seconds on a warm machine. Its
 *      answer is persisted, so a window pays this at most once per ten
 *      minutes of picker use.
 *
 * Tier 3 is the only place WAT321 spawns codex outside a dispatch, and
 * it is deliberate: the caller is the Codex model picker or the repair
 * flow, so the user has explicitly asked what models exist. It is a
 * separate child from the dispatcher's, so the dispatcher's warm client
 * and 15-minute idle timer are untouched either way.
 *
 * Never throws. On any failure the catalog keeps its last answer, the
 * picker falls back to `~/.codex/models_cache.json` when there was
 * none, and validity keeps failing open.
 */
export async function ensureCodexCatalog(
  logger: EpicHandshakeLogger,
  opts: { force?: boolean } = {}
): Promise<void> {
  const force = opts.force === true;
  if (!force) {
    if (codexCatalogAgeMs() <= CATALOG_FRESH_FOR_MS) return;
    await hydrateCodexCatalog(logger);
    if (codexCatalogAgeMs() <= CATALOG_FRESH_FOR_MS) return;
  }

  let client: AppServerClient | null = null;
  try {
    const resolved = await resolveCodexCli();
    if (resolved === null) return;
    logger.info(
      force
        ? "[catalog] refresh requested, asking codex directly for its models"
        : "[catalog] no fresh answer, asking codex directly for its models"
    );
    client = await spawnInitializedAppServer(logger, "catalogProbe", resolved);
    await syncCodexCatalog(client, resolved, logger);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.info(`[catalog] direct probe failed (${msg}), using file fallback`);
  } finally {
    // Always reap the probe child. It exists for one request.
    try {
      await client?.shutdown(1000);
    } catch {
      // best-effort
    }
  }
}

/** The picker's REFRESH row. Asks the app-server again whatever the age
 * of the current answer, for the day a model is switched on for this
 * account and the user wants it now rather than within ten minutes. */
export function refreshCodexCatalog(logger: EpicHandshakeLogger): Promise<void> {
  return ensureCodexCatalog(logger, { force: true });
}
