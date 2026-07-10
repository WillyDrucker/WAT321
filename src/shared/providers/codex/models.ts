import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  catalogDefaultEffort,
  catalogDefaultSlug,
  getCodexCatalog,
  type CodexCatalogEntry,
  type CodexModelInfo,
} from "./modelCatalog";

/**
 * Model facts for the Codex tier, resolved from two sources in a fixed
 * order of authority:
 *
 *   1. The live catalog in `modelCatalog.ts`, filled from the
 *      `model/list` RPC on the app-server the bridge actually
 *      dispatches to. Authoritative, because it describes the process
 *      that will run the turn.
 *   2. `~/.codex/models_cache.json`, used only until the app-server has
 *      answered, or when it never will (no codex installed, a codex too
 *      old to know `model/list`).
 *
 * The file is NOT trustworthy on its own. Every codex binary on the
 * machine overwrites that one path with the catalog its own version
 * knows, and the backend tailors that catalog to the asking client.
 * Someone running the OpenAI ChatGPT VS Code extension next to the npm
 * CLI has two writers racing over one file, so the file routinely
 * describes a binary we never dispatch to. That is how a model the
 * running Codex fully supports ends up missing from the picker and
 * flagged invalid by `isKnownCodexModel`.
 *
 * The split that governs everything below: the file is a DISPLAY hint,
 * and only the catalog GATES.
 *   - Display (picker rows, model info) may fall back to the file. An
 *     approximate list beats an empty one, and a wrong row costs the
 *     user a turn error at worst.
 *   - Gating (`isKnownCodexModel`, `listKnownCodexSlugs`) reads the
 *     catalog alone. A file written by some other codex must never
 *     decide that a session is broken, nor bless a slug the running
 *     app-server would 404 on.
 *   - Gating FAILS OPEN with no catalog. "Cannot validate" must never
 *     mean "reject", or a window that has not asked yet would block
 *     every `thread/resume`.
 *
 * `ensureCodexCatalog` (EH tier) fills the catalog before any picker
 * draws a row, so the fallback is rare rather than routine.
 *
 * `~/.codex/config.toml` is not read here, or anywhere in WAT321. It is
 * a machine-wide Codex CLI preference that Codex's own TUI writes when a
 * user picks a model there. Honoring it made a fresh WAT321 install
 * behave differently on two machines for reasons our UI never showed,
 * and it is not what "Codex's default" means. Sessions pin their own
 * model. See `WAT321_EPIC_HANDSHAKE/codexSessionSettings.ts`.
 *
 * Note `model/list` carries no `context_window`. The auto-compact
 * ceiling therefore stays file-sourced, with its own fallback onto the
 * rollout's `token_count` event. See
 * `WAT321_CODEX_SESSION_TOKENS/autoCompactLimit.ts`.
 *
 * Safe to call on every dispatch: the file is a few hundred KB and
 * parsed in a fraction of a ms, and the catalog is an in-memory array.
 */

const MODELS_CACHE_PATH = join(homedir(), ".codex", "models_cache.json");

interface ReasoningLevelEntry {
  effort?: string;
  description?: string;
}

interface ModelsCacheEntry {
  slug?: string;
  display_name?: string;
  description?: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: ReasoningLevelEntry[];
  visibility?: string;
  priority?: number;
}

interface ModelsCacheFile {
  models?: ModelsCacheEntry[];
}

/** Public-facing shape for the model + effort picker. Defined alongside
 * the catalog (its primary producer) and re-exported here so the many
 * existing importers of this module keep working unchanged. */
export type { CodexModelInfo };

/** Read and parse `~/.codex/models_cache.json`. Returns null on any
 * I/O or parse failure - callers treat null as "cannot validate, do
 * not gate." */
function readModelsCache(): ModelsCacheFile | null {
  if (!existsSync(MODELS_CACHE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MODELS_CACHE_PATH, "utf8")) as ModelsCacheFile;
  } catch {
    return null;
  }
}

/** Every model slug the running Codex can serve.
 *
 * Catalog only. An empty array means "we could not ask the app-server",
 * which is exactly what the repair picker reports as "validation could
 * not run". Falling back to the cache file here would make that branch
 * lie, because the file may enumerate a different binary's models. */
export function listKnownCodexSlugs(): string[] {
  const catalog = getCodexCatalog();
  return catalog === null ? [] : catalog.map((entry) => entry.slug);
}

/** Every reasoning level any known model advertises. Hidden models
 * count: visibility governs what the picker offers, not what Codex
 * accepts on the wire. Empty when nothing can be read, which callers
 * treat as "cannot validate" rather than "nothing is valid".
 *
 * Effort names are OpenAI's to define, so reading them keeps WAT321
 * from carrying a list that goes stale on the next model release. Both
 * `max` and `ultra` arrived with GPT-5.6 and were silently dropped by
 * the hardcoded quartet this replaced. */
export function listKnownCodexEffortLevels(): ReadonlySet<string> {
  const out = new Set<string>();
  const catalog = getCodexCatalog();
  if (catalog !== null) {
    for (const entry of catalog) {
      for (const level of entry.supportedEfforts) out.add(level.effort);
    }
    return out;
  }
  const cache = readModelsCache();
  if (!cache?.models) return out;
  for (const entry of cache.models) {
    for (const level of entry.supported_reasoning_levels ?? []) {
      if (typeof level.effort === "string" && level.effort.length > 0) {
        out.add(level.effort);
      }
    }
  }
  return out;
}

/** True if the running Codex can be expected to accept this slug.
 *
 * The catalog is the ONLY authority, and the cache file gates nothing.
 * The file is a DISPLAY hint: it is routinely written by a different
 * codex binary than the one we dispatch to, so letting it decide
 * validity produces both kinds of error. It rejects a model the running
 * Codex supports, firing a bogus "repair this session" prompt. And it
 * accepts one the running Codex has never heard of, which then 404s at
 * `turn/start` with the repair picker never firing.
 *
 * No catalog means "cannot validate", which must never mean "reject".
 * A codex too old for `model/list`, an unspawnable app-server, or a
 * window where nothing has asked yet would otherwise block every
 * `thread/resume` and strand existing Epic Handshake sessions. So it
 * fails open and the badge simply stays quiet until we can ask.
 *
 * The cost is a session pinned to a hidden slug. `model/list` omits
 * hidden models (0.142.5 returns 3 where its file lists 4, the
 * difference being `codex-auto-review`), so such a session is flagged
 * for repair. Acceptable: the bridge only ever pins a model the user
 * chose from a visible list, and a spurious repair prompt is
 * recoverable where a 404 mid-turn is not. */
export function isKnownCodexModel(slug: string | null): boolean {
  if (!slug) return true;
  const catalog = getCodexCatalog();
  if (catalog === null) return true;
  return catalog.some((entry) => entry.slug === slug);
}

/** The slug Codex itself runs when `config.toml` names no model.
 *
 * Sourced from `model/list`'s `isDefault` flag, which tracks the
 * binary: 0.142.5 reports `gpt-5.5`, 0.144.x reports `gpt-5.6-sol`.
 * The cache file has no equivalent, so the file path falls back to
 * `priority` ordering, which is the guess `isDefault` replaces. Null
 * when neither source can answer. */
export function defaultCodexModelSlug(): string | null {
  const fromCatalog = catalogDefaultSlug();
  if (fromCatalog !== null) return fromCatalog;
  const selectable = listSelectableCodexModels();
  return selectable.length > 0 ? selectable[0].slug : null;
}

/** The effort Codex recommends for the model it recommends.
 *
 * Pairs with `defaultCodexModelSlug`. Together they answer "what would
 * a brand-new Codex session run", which is what a brand-new Epic
 * Handshake session is initialized to.
 *
 * Falls back to the default model's `defaultEffort` as read from the
 * cache file when no app-server has answered. Null when neither source
 * knows, and null is a legal thing to send: `turn/start` reads a null
 * effort as "inherit", which beats inventing a level Codex never
 * named. */
export function defaultCodexEffortLevel(): string | null {
  const fromCatalog = catalogDefaultEffort();
  if (fromCatalog !== null) return fromCatalog;
  const slug = defaultCodexModelSlug();
  if (slug === null) return null;
  return getCodexModelInfo(slug)?.defaultEffort ?? null;
}

/** Resolve the rich info for a model slug, catalog first. Returns null
 * when neither source knows it. Caller falls back to a slug-only
 * display when null comes back.
 *
 * The catalog is checked first so a model the running Codex supports
 * renders with its real display name and effort list even while the
 * shared cache file describes some other binary's catalog. */
export function getCodexModelInfo(slug: string): CodexModelInfo | null {
  const catalog = getCodexCatalog();
  if (catalog !== null) {
    const hit = catalog.find((entry) => entry.slug === slug);
    if (hit) return hit;
  }
  const cache = readModelsCache();
  if (!cache?.models) return null;
  for (const entry of cache.models) {
    if (entry.slug !== slug) continue;
    return modelEntryToInfo(entry);
  }
  return null;
}

/** All models the user should see in the picker.
 *
 * Catalog first, because the picker must never offer a model the
 * dispatch binary would 404 on. `model/list` already omits hidden
 * models and returns them in Codex's own recommended order, so no
 * filtering or `priority` sort is needed on that path.
 *
 * The file path keeps the old behavior for users whose app-server has
 * not answered yet: filter `visibility === "list"` and sort by
 * `priority` ascending so the recommended model lands first. */
export function listSelectableCodexModels(): CodexModelInfo[] {
  const catalog = getCodexCatalog();
  if (catalog !== null) {
    return catalog.filter((entry) => !entry.hidden).map(toPlainInfo);
  }
  const cache = readModelsCache();
  if (!cache?.models) return [];
  const selectable = cache.models.filter((m) => m.visibility === "list");
  selectable.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  return selectable
    .map((m) => modelEntryToInfo(m))
    .filter((m): m is CodexModelInfo => m !== null);
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
  };
}

function modelEntryToInfo(entry: ModelsCacheEntry): CodexModelInfo | null {
  if (typeof entry.slug !== "string" || entry.slug.length === 0) return null;
  return {
    slug: entry.slug,
    displayName: entry.display_name ?? entry.slug,
    description: entry.description ?? "",
    defaultEffort: entry.default_reasoning_level ?? null,
    supportedEfforts: (entry.supported_reasoning_levels ?? [])
      .filter((e): e is { effort: string; description?: string } =>
        typeof e.effort === "string"
      )
      .map((e) => ({ effort: e.effort, description: e.description ?? "" })),
  };
}

/** Pick a repair target for an invalid model slug. Priority:
 *   1. The slug the running app-server marks `isDefault`
 *   2. First selectable model, a model Codex definitely supports here
 *   3. null - no safe repair possible, caller falls back to Reset
 *
 * Repairing onto Codex's own recommendation is the only choice that is
 * valid by construction: the app-server named it, so `turn/start` will
 * accept it. An earlier version preferred `~/.codex/config.toml`, which
 * could itself hold the bad slug that caused the drift. */
export function preferredRepairSlug(): string | null {
  return defaultCodexModelSlug();
}
