/**
 * In-memory catalog of the models the Codex app-server WAT321 actually
 * dispatches to reports for itself, via the `model/list` RPC.
 *
 * Why this exists. `~/.codex/models_cache.json` is a single file that
 * EVERY codex binary on the machine overwrites with the catalog its own
 * version knows, and the backend tailors that catalog to the asking
 * client's version. A user running the OpenAI ChatGPT VS Code extension
 * alongside the npm CLI has two writers and one file, last writer wins.
 * The file can therefore describe a binary we never dispatch to: models
 * vanish from the picker, and slugs the running app-server handles fine
 * get flagged as unknown. The app-server answers for itself, so it is
 * the only source that always matches the process running the turn.
 *
 * Populated opportunistically by `codexDispatcher.ensureClient()` right
 * after `initialize`, on an app-server that was already being spawned.
 * The catalog NEVER spawns a process of its own and never touches the
 * dispatcher's idle timer, so warm / cold behavior is unchanged and no
 * picker or tooltip hover can trigger a cold start.
 *
 * Lifetime is owned by the dispatcher, which clears the catalog on force
 * restart and on stop so an answer cannot outlive the process that gave
 * it. It deliberately SURVIVES an idle shutdown, because the same binary
 * respawns and its answer is still true.
 *
 * Empty until the first successful `initialize`. Callers MUST fail open
 * while it is empty: an absent answer means "cannot validate", never
 * "reject". Once non-null it is authoritative and must not be unioned
 * with the cache file, which may describe a different binary entirely.
 *
 * Deliberately absent from `model/list`: `context_window`. That field
 * lives only in the cache file, so the auto-compact ceiling stays
 * file-sourced. See `WAT321_CODEX_SESSION_TOKENS/autoCompactLimit.ts`.
 */

/** Shape the model and effort pickers render from. Mirrors what both
 * the `model/list` RPC and the cache file can supply, so either source
 * can populate it. */
export interface CodexModelInfo {
  slug: string;
  displayName: string;
  description: string;
  defaultEffort: string | null;
  supportedEfforts: { effort: string; description: string }[];
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

/** Replace the catalog with an app-server's answer.
 *
 * The gate: an empty list is treated as "no catalog" rather than "no
 * models", because an app-server that returns nothing is a failure mode.
 * Storing it would make `isKnownCodexModel` reject every slug, since the
 * catalog is authoritative once non-null. Callers rely on `null` meaning
 * "fall back to the file and fail open", so this invariant is
 * load-bearing: `getCodexCatalog()` never returns an empty array. */
export function setCodexCatalog(next: readonly CodexCatalogEntry[]): void {
  catalog = next.length > 0 ? next : null;
}

/** The live catalog, or null when no app-server has answered yet.
 * Null is the signal to fall back to the cache file and fail open. */
export function getCodexCatalog(): readonly CodexCatalogEntry[] | null {
  return catalog;
}

/** Drop the catalog. Called when the app-server is force-restarted or
 * the dispatcher stops, so a stale answer cannot outlive the process
 * that gave it. */
export function clearCodexCatalog(): void {
  catalog = null;
}

/** The slug the app-server marks `isDefault`. This is Codex's own
 * answer to "which model runs when config.toml names none", and it
 * tracks the binary: 0.142.5 reports `gpt-5.5`, 0.144.x reports
 * `gpt-5.6-sol`. Null when no catalog or no entry claims the flag. */
export function catalogDefaultSlug(): string | null {
  const entries = getCodexCatalog();
  if (entries === null) return null;
  return entries.find((e) => e.isDefault)?.slug ?? null;
}
