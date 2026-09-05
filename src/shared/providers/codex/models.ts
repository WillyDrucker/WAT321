import {
  catalogDefaultEffort,
  catalogDefaultSlug,
  getCodexCatalog,
  type CodexCatalogEntry,
  type CodexModelInfo,
  type CodexModelUpgrade,
} from "./modelCatalog";
import {
  cacheFileEffortLevels,
  cacheFileModelInfo,
  cacheFileSelectableModels,
} from "./modelsCacheFile";
import { hasUnlistedPin, listUnlistedPins } from "./unlistedModelPins";

/**
 * Model facts for the Codex tier, resolved from sources in a fixed
 * order of authority:
 *
 *   1. The live catalog in `modelCatalog.ts`, filled from `model/list`
 *      on the app-server the bridge actually dispatches to, hidden
 *      models included. Authoritative, because it describes the process
 *      that will run the turn.
 *   2. The user's own typed pins in `unlistedModelPins.ts`, for a slug
 *      no app-server has listed yet. Explicit intent, so the gate lets
 *      it through and the API gives the real answer.
 *   3. `~/.codex/models_cache.json` via `modelsCacheFile.ts`, for
 *      display only, until the app-server has answered or when it never
 *      will (no codex installed, a codex too old to know `model/list`).
 *
 * The split that governs everything below: the file is a DISPLAY hint,
 * and only the catalog and the pins GATE. A file written by some other
 * codex must never decide that a session is broken, nor bless a slug
 * the running app-server would 404 on.
 *
 * Gating FAILS OPEN with no catalog. "Cannot validate" must never mean
 * "reject", or a window that has not asked yet would block every
 * `thread/resume`.
 *
 * The catalog also ages. The backend decides per ACCOUNT which models a
 * binary may list (GPT-6 Astra arrived as a staged rollout under an
 * unchanged codex, hidden from the picker), so `codexCatalogRefresh.ts`
 * re-asks when the answer is old.
 *
 * `~/.codex/config.toml` is not read here, or anywhere in WAT321. It is
 * a machine-wide Codex CLI preference that Codex's own TUI writes, and
 * honoring it made a fresh install behave differently on two machines
 * for reasons the UI never showed. Sessions pin their own model, see
 * `WAT321_EPIC_HANDSHAKE/codexSettings/codexSessionSettings.ts`.
 *
 * `model/list` carries no `context_window`, so the auto-compact ceiling
 * stays file-sourced. See `WAT321_CODEX_SESSION_TOKENS/autoCompactLimit.ts`.
 */

/** Public-facing shapes for the pickers, re-exported from the catalog
 * (their producer) so importers need one module. */
export type { CodexModelInfo, CodexModelUpgrade };

/** Every model slug the running Codex lists, hidden ones included.
 *
 * Catalog only. An empty array means "we could not ask the app-server",
 * which is exactly what the repair picker reports as "validation could
 * not run". Falling back to the cache file here would make that branch
 * lie, because the file may enumerate a different binary's models. */
export function listKnownCodexSlugs(): string[] {
  const catalog = getCodexCatalog();
  return catalog === null ? [] : catalog.map((entry) => entry.slug);
}

/** Every reasoning level any known model advertises, with the first
 * description seen for it. Catalog when it has answered, the file
 * otherwise, empty when nothing can be read. Effort names are OpenAI's
 * to define, so reading them keeps WAT321 from carrying a list that
 * goes stale on the next model release. */
export function listCodexEffortLevelsAcrossModels(): {
  effort: string;
  description: string;
}[] {
  const catalog = getCodexCatalog();
  if (catalog === null) return cacheFileEffortLevels();
  const out: { effort: string; description: string }[] = [];
  const seen = new Set<string>();
  for (const entry of catalog) {
    for (const level of entry.supportedEfforts) {
      if (seen.has(level.effort)) continue;
      seen.add(level.effort);
      out.push(level);
    }
  }
  return out;
}

/** The effort names alone, for validating a persisted level. */
export function listKnownCodexEffortLevels(): ReadonlySet<string> {
  return new Set(listCodexEffortLevelsAcrossModels().map((l) => l.effort));
}

/** True if the running Codex can be expected to accept this slug, or
 * the user pinned it by hand and asked to find out.
 *
 * No catalog means "cannot validate", which must never mean "reject".
 * A codex too old for `model/list`, an unspawnable app-server, or a
 * window where nothing has asked yet would otherwise block every
 * `thread/resume` and strand existing Epic Handshake sessions. So it
 * fails open and the badge simply stays quiet until we can ask. */
export function isKnownCodexModel(slug: string | null): boolean {
  if (!slug) return true;
  const catalog = getCodexCatalog();
  if (catalog === null) return true;
  if (catalog.some((entry) => entry.slug === slug)) return true;
  return hasUnlistedPin(slug);
}

/** True for a model Codex keeps out of its own picker (a hidden catalog
 * entry) or one the user pinned by slug. Drives the "unlisted" marks. */
export function isUnlistedCodexModel(slug: string): boolean {
  const catalog = getCodexCatalog();
  const entry = catalog?.find((e) => e.slug === slug);
  if (entry !== undefined) return entry.hidden;
  return hasUnlistedPin(slug);
}

/** The slug Codex itself runs when `config.toml` names no model.
 * Sourced from `model/list`'s `isDefault` flag. The cache file has no
 * equivalent, so the file path falls back to `priority` ordering. Null
 * when neither source can answer. */
export function defaultCodexModelSlug(): string | null {
  const fromCatalog = catalogDefaultSlug();
  if (fromCatalog !== null) return fromCatalog;
  const selectable = listSelectableCodexModels();
  return selectable.length > 0 ? selectable[0].slug : null;
}

/** The effort Codex recommends for the model it recommends. Together
 * with `defaultCodexModelSlug` this is what a brand-new session runs.
 * Null when neither source knows, and null is a legal thing to send:
 * `turn/start` reads a null effort as "inherit", which beats inventing
 * a level Codex never named. */
export function defaultCodexEffortLevel(): string | null {
  const fromCatalog = catalogDefaultEffort();
  if (fromCatalog !== null) return fromCatalog;
  const slug = defaultCodexModelSlug();
  if (slug === null) return null;
  return getCodexModelInfo(slug)?.defaultEffort ?? null;
}

/** Rich info for a slug, catalog first so a model the running Codex
 * supports renders with its real display name and effort list even
 * while the shared cache file describes some other binary. Null when
 * neither source knows it, and callers then fall back to a slug-only
 * display. */
export function getCodexModelInfo(slug: string): CodexModelInfo | null {
  const catalog = getCodexCatalog();
  if (catalog !== null) {
    const hit = catalog.find((entry) => entry.slug === slug);
    if (hit) return toPlainInfo(hit);
  }
  return cacheFileModelInfo(slug);
}

/** The models the picker offers by default: what Codex itself shows.
 * `model/list` returns them in Codex's own recommended order, so no
 * sort is needed on that path. The file path filters and sorts. */
export function listSelectableCodexModels(): CodexModelInfo[] {
  const catalog = getCodexCatalog();
  if (catalog !== null) {
    return catalog.filter((entry) => !entry.hidden).map(toPlainInfo);
  }
  return cacheFileSelectableModels();
}

/** The models the picker offers under its Unlisted heading: hidden
 * catalog entries, then typed pins the catalog does not carry. A pin is
 * slug-only until some source describes it. */
export function listUnlistedCodexModels(): CodexModelInfo[] {
  const catalog = getCodexCatalog();
  const hidden =
    catalog === null ? [] : catalog.filter((entry) => entry.hidden).map(toPlainInfo);
  const known = new Set(hidden.map((m) => m.slug));
  if (catalog !== null) for (const entry of catalog) known.add(entry.slug);
  const pinned = listUnlistedPins()
    .filter((slug) => !known.has(slug))
    .map((slug) => getCodexModelInfo(slug) ?? slugOnlyInfo(slug));
  return [...hidden, ...pinned];
}

/** Strip the catalog-only fields so callers see one uniform shape
 * regardless of which source answered. */
function toPlainInfo(entry: CodexCatalogEntry): CodexModelInfo {
  return {
    slug: entry.slug,
    displayName: entry.displayName,
    description: entry.description,
    defaultEffort: entry.defaultEffort,
    supportedEfforts: entry.supportedEfforts,
    upgrade: entry.upgrade,
  };
}

function slugOnlyInfo(slug: string): CodexModelInfo {
  return {
    slug,
    displayName: slug,
    description: "",
    defaultEffort: null,
    supportedEfforts: [],
    upgrade: null,
  };
}

/** Pick a repair target for an invalid model slug. Priority:
 *   1. The successor Codex names for that slug, when the running
 *      app-server lists it. A retired model's own pointer is the closest
 *      thing to what the session was doing.
 *   2. The slug the running app-server marks `isDefault`
 *   3. First selectable model, a model Codex definitely supports here
 *   4. null - no safe repair possible, caller falls back to Reset
 *
 * Every candidate is valid by construction: the app-server named it, so
 * `turn/start` will accept it. `~/.codex/config.toml` is never a
 * candidate, since it can hold the very slug that caused the drift. */
export function preferredRepairSlug(badSlug: string | null = null): string | null {
  if (badSlug !== null) {
    const successor = getCodexModelInfo(badSlug)?.upgrade?.model ?? null;
    if (successor !== null && listKnownCodexSlugs().includes(successor)) {
      return successor;
    }
  }
  return defaultCodexModelSlug();
}
