/**
 * In-memory catalog of the models the Codex app-server WAT321 actually
 * dispatches to reports for itself, via the `model/list` RPC.
 *
 * It exists because `~/.codex/models_cache.json` is one file that every
 * codex binary on the machine overwrites with its own version's
 * catalog (the ChatGPT VS Code extension beside the npm CLI is two
 * writers, last one wins), so the file can describe a binary we never
 * dispatch to. The app-server answers for the process that runs the
 * turn. The answer is also tied to a moment: the backend decides per
 * account what a binary may list and can switch a model on with no
 * upgrade, so `fetchedAt` lets a picker decide to ask again.
 *
 * Filled by `codexDispatcher.ensureClient()` right after `initialize`
 * on an app-server already being spawned. The catalog never spawns a
 * process or touches the idle timer, so no hover can trigger a cold
 * start (the picker's one deliberate spawn is `codexCatalogSync.ts`).
 * The dispatcher clears it on force restart and on stop, and it
 * survives an idle shutdown because the same binary respawns.
 *
 * Empty until the first `initialize`. Callers MUST fail open while it
 * is empty, and once non-null it is authoritative and never unioned
 * with the cache file. `model/list` carries no `context_window`, so the
 * auto-compact ceiling stays file-sourced, see
 * `WAT321_CODEX_SESSION_TOKENS/autoCompactLimit.ts`.
 */

/** A model OpenAI is retiring, and what Codex recommends in its place.
 * Both `model/list` (`upgradeInfo`) and the cache file (`upgrade`) carry
 * it. `retirementAtMs` is null when a source names a successor without a
 * date. */
export interface CodexModelUpgrade {
  model: string;
  retirementAtMs: number | null;
}

/** A speed tier a model offers beyond standard, such as Fast. `id` is
 * what `turn/start` takes as `serviceTier`, `name` what the user sees. */
export interface CodexServiceTier {
  id: string;
  name: string;
  description: string;
}

/** Shape the model and effort pickers render from. Mirrors what both
 * the `model/list` RPC and the cache file can supply, so either source
 * can populate it. */
export interface CodexModelInfo {
  slug: string;
  displayName: string;
  description: string;
  defaultEffort: string | null;
  supportedEfforts: { effort: string; description: string }[];
  upgrade: CodexModelUpgrade | null;
  /** Empty when the model offers only standard speed, or when the
   * source that described it predates tiers. */
  serviceTiers: CodexServiceTier[];
}

/** A catalog row. Adds the two facts only `model/list` carries:
 * `hidden` (the RPC already omits hidden models, so this is belt and
 * braces) and `isDefault`, which replaces the `priority`-ordering guess
 * the cache file forced on us. */
export interface CodexCatalogEntry extends CodexModelInfo {
  hidden: boolean;
  isDefault: boolean;
}

let catalog: readonly CodexCatalogEntry[] | null = null;
let fetchedAtMs = 0;

/** Replace the catalog with an app-server's answer.
 *
 * The gate: an empty list is treated as "no catalog" rather than "no
 * models", because an app-server that returns nothing is a failure mode.
 * Storing it would make `isKnownCodexModel` reject every slug, since the
 * catalog is authoritative once non-null. Callers rely on `null` meaning
 * "fall back to the file and fail open", so this invariant is
 * load-bearing: `getCodexCatalog()` never returns an empty array.
 *
 * `fetchedAt` is when the app-server answered. Pass the sidecar's stamp
 * when rehydrating so the age stays honest across windows, and 0 for an
 * answer of unknown age, which reads as "ask again at the next chance". */
export function setCodexCatalog(
  next: readonly CodexCatalogEntry[],
  fetchedAt: number = Date.now()
): void {
  catalog = next.length > 0 ? next : null;
  fetchedAtMs = catalog === null ? 0 : fetchedAt;
}

/** The live catalog, or null when no app-server has answered yet.
 * Null is the signal to fall back to the cache file and fail open. */
export function getCodexCatalog(): readonly CodexCatalogEntry[] | null {
  return catalog;
}

/** Milliseconds since the app-server gave the current answer. Infinity
 * when there is no catalog or the answer's age is unknown, so any "older
 * than X" test says ask again. */
export function codexCatalogAgeMs(now: number = Date.now()): number {
  if (catalog === null || fetchedAtMs <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - fetchedAtMs);
}

/** Drop the catalog. Called when the app-server is force-restarted or
 * the dispatcher stops, so a stale answer cannot outlive the process
 * that gave it. */
export function clearCodexCatalog(): void {
  catalog = null;
  fetchedAtMs = 0;
}

/** The slug the app-server marks `isDefault`. This is Codex's own
 * answer to "which model runs when config.toml names none", and it
 * tracks the binary, so upgrading codex can move it. Null when no
 * catalog or no entry claims the flag. */
export function catalogDefaultSlug(): string | null {
  const entries = getCodexCatalog();
  if (entries === null) return null;
  return entries.find((e) => e.isDefault)?.slug ?? null;
}

/** The `defaultReasoningEffort` of whichever model claims `isDefault`.
 *
 * The pair (`catalogDefaultSlug`, `catalogDefaultEffort`) is the whole
 * of "what Codex recommends for a brand-new session". Both are read
 * live rather than hardcoded, so the day OpenAI promotes a different
 * model or retunes its effort, a newly created Epic Handshake session
 * picks it up with no code change.
 *
 * Null when no catalog, or when the default model advertises no effort.
 * Callers must not substitute a guess of their own: a null here means
 * "Codex did not say", and `turn/start` accepts a null effort as
 * "inherit", which is the honest thing to send. */
export function catalogDefaultEffort(): string | null {
  const entries = getCodexCatalog();
  if (entries === null) return null;
  return entries.find((e) => e.isDefault)?.defaultEffort ?? null;
}
