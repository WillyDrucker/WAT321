import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexModelInfo, CodexModelUpgrade } from "./modelCatalog";

/**
 * Reader for `~/.codex/models_cache.json`, the DISPLAY fallback behind
 * the live catalog. Every codex binary on the machine overwrites this
 * one file with the catalog its own version was served, so nothing
 * here gates a session: it fills picker rows and model info until an
 * app-server has answered, and `models.ts` decides when to consult it.
 *
 * Field names are the file's own snake_case. `model/list` renames every
 * one of them, see the warning on `ModelListEntry` in
 * `WAT321_EPIC_HANDSHAKE/appServer/protocol.ts`.
 *
 * Cheap to read on every call: a few hundred KB parsed in a fraction of
 * a millisecond.
 */

const MODELS_CACHE_PATH = join(homedir(), ".codex", "models_cache.json");

interface ReasoningLevelEntry {
  effort?: string;
  description?: string;
}

/** The file's retirement pointer. `retirement_at` is ISO-8601 where
 * `model/list` sends epoch seconds. */
interface ModelsCacheUpgrade {
  model?: string;
  retirement_at?: string;
}

interface ModelsCacheEntry {
  slug?: string;
  display_name?: string;
  description?: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: ReasoningLevelEntry[];
  visibility?: string;
  priority?: number;
  upgrade?: ModelsCacheUpgrade | null;
}

interface ModelsCacheFile {
  models?: ModelsCacheEntry[];
}

/** Parsed entries, or an empty list on any I/O or parse failure.
 * Callers treat empty as "nothing known", never as "nothing valid". */
function readCacheEntries(): ModelsCacheEntry[] {
  if (!existsSync(MODELS_CACHE_PATH)) return [];
  try {
    const parsed = JSON.parse(
      readFileSync(MODELS_CACHE_PATH, "utf8")
    ) as ModelsCacheFile;
    return Array.isArray(parsed.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

function upgradeFromCache(
  raw: ModelsCacheUpgrade | null | undefined
): CodexModelUpgrade | null {
  if (typeof raw !== "object" || raw === null) return null;
  if (typeof raw.model !== "string" || raw.model.length === 0) return null;
  const parsed =
    typeof raw.retirement_at === "string" ? Date.parse(raw.retirement_at) : NaN;
  return {
    model: raw.model,
    retirementAtMs: Number.isNaN(parsed) ? null : parsed,
  };
}

function toModelInfo(entry: ModelsCacheEntry): CodexModelInfo | null {
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
    upgrade: upgradeFromCache(entry.upgrade),
  };
}

/** Info for one slug as the file describes it, or null. */
export function cacheFileModelInfo(slug: string): CodexModelInfo | null {
  const entry = readCacheEntries().find((m) => m.slug === slug);
  return entry === undefined ? null : toModelInfo(entry);
}

/** The models the file marks visible, in the file's own `priority`
 * order so the recommended model lands first. */
export function cacheFileSelectableModels(): CodexModelInfo[] {
  const selectable = readCacheEntries().filter((m) => m.visibility === "list");
  selectable.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  return selectable
    .map(toModelInfo)
    .filter((m): m is CodexModelInfo => m !== null);
}

/** Every reasoning level any model in the file advertises, with the
 * first description seen for it, in first-seen order. Hidden models
 * count: visibility governs the picker, not what Codex accepts. */
export function cacheFileEffortLevels(): { effort: string; description: string }[] {
  const out: { effort: string; description: string }[] = [];
  const seen = new Set<string>();
  for (const entry of readCacheEntries()) {
    for (const level of entry.supported_reasoning_levels ?? []) {
      if (typeof level.effort !== "string" || level.effort.length === 0) continue;
      if (seen.has(level.effort)) continue;
      seen.add(level.effort);
      out.push({ effort: level.effort, description: level.description ?? "" });
    }
  }
  return out;
}
