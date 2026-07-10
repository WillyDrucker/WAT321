import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
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
 * Two rules hold everywhere below:
 *   - The picker shows the CATALOG only. It must never offer a model
 *     the dispatch binary would 404 on.
 *   - Validity FAILS OPEN. A slug is accepted when it appears in the
 *     catalog or the file, and when neither can be read we accept
 *     everything. "Cannot validate" must never mean "reject", or a
 *     failed prewarm would block every `thread/resume`.
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

/** Slugs from the cache file alone. Kept separate from the catalog so
 * `isKnownCodexModel` can union the two without conflating sources. */
function fileSlugs(): string[] {
  const cache = readModelsCache();
  if (!cache?.models) return [];
  const out: string[] = [];
  for (const entry of cache.models) {
    if (typeof entry.slug === "string" && entry.slug.length > 0) {
      out.push(entry.slug);
    }
  }
  return out;
}

/** Every model slug the running Codex can serve, catalog first. Used by
 * the repair picker to suggest a replacement slug, and by diagnostics.
 * Empty only when neither source is readable. */
export function listKnownCodexSlugs(): string[] {
  const catalog = getCodexCatalog();
  if (catalog !== null) return catalog.map((entry) => entry.slug);
  return fileSlugs();
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
 * When a catalog exists it is the ONLY authority. Never union it with
 * the cache file. The file is routinely written by a different codex
 * binary than the one we dispatch to, so a slug present only in the
 * file is precisely the case this validation exists to catch: an old
 * app-server plus a file written by a newer codex would accept
 * `gpt-5.6-sol` here and then 404 at `turn/start`, with the repair
 * picker never firing.
 *
 * The cost is a session pinned to a hidden slug. `model/list` omits
 * hidden models (0.142.5 returns 3 where its file lists 4, the
 * difference being `codex-auto-review`), so such a session would be
 * flagged for repair. That is acceptable: the bridge only ever pins a
 * model the user chose from a visible list, and a spurious repair
 * prompt is recoverable where a 404 mid-turn is not.
 *
 * Still FAILS OPEN when nothing can be read. "Cannot validate" must
 * never mean "reject", or a failed prewarm, a missing cache, or a codex
 * too old for `model/list` would block every `thread/resume` and strand
 * existing Epic Handshake sessions.
 *
 * Returns `false` only when a source WAS readable and the slug is
 * definitely absent from it. */
export function isKnownCodexModel(slug: string | null): boolean {
  if (!slug) return true;
  const catalog = getCodexCatalog();
  if (catalog !== null) {
    return catalog.some((entry) => entry.slug === slug);
  }
  const fromFile = fileSlugs();
  // Nothing could be read at all. Fail open.
  if (fromFile.length === 0) return true;
  return fromFile.includes(slug);
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

/** Read the `model = "..."` key from `~/.codex/config.toml`. Minimal
 * TOML scan - we only care about the top-level `model` string, which
 * is the Codex CLI's default model slug. Returns null when the file
 * is missing, the key is unset, or the value is not a string. Safe
 * for display paths. */
export function readCodexConfigModel(): string | null {
  const configPath = join(homedir(), ".codex", "config.toml");
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) continue;
      // Match `model = "slug"` or `model='slug'` at the top level.
      // Nested `[profiles.*]` sections may also define `model`, but
      // we scan the whole file top-down and pick the first match -
      // the top-level one precedes any section header by convention.
      // Stop at the first `[section]` header so a profile-scoped
      // model doesn't shadow the top-level default.
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) break;
      const m = /^model\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/.exec(trimmed);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
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
 *   1. Codex CLI's configured default (from config.toml) if valid
 *   2. The slug the running app-server marks `isDefault`
 *   3. First selectable model, a model Codex definitely supports here
 *   4. null - no safe repair possible, caller falls back to Reset
 *
 * Validating the config.toml default before picking it protects against
 * the case where config itself stores the bad slug, which is the likely
 * origin of the drift in the first place. Step 2 is Codex's own answer
 * rather than our old guess of "whatever sorted first by priority". */
export function preferredRepairSlug(): string | null {
  const configDefault = readCodexConfigModel();
  if (configDefault && isKnownCodexModel(configDefault)) return configDefault;
  return defaultCodexModelSlug();
}
