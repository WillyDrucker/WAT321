import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read-only accessor for `~/.codex/models_cache.json`, the list of
 * model slugs the Codex CLI recognizes locally. The session-token
 * tooltip uses it to flag a stored model slug that has drifted out of
 * the installed CLI's known set (a renamed or retired model, which
 * would 404 on the next prompt) and to show the model's default
 * reasoning level.
 *
 * The cache refreshes on Codex CLI upgrades, so validation reflects
 * the current installed set automatically. Safe to call on every
 * render: the file is typically under 4KB and parsed in a fraction of
 * a ms. Failures collapse to `null` / `true` so a missing or
 * unreadable cache never gates display.
 */

const MODELS_CACHE_PATH = join(homedir(), ".codex", "models_cache.json");

interface ModelsCacheEntry {
  slug?: string;
  default_reasoning_level?: string;
}

interface ModelsCacheFile {
  models?: ModelsCacheEntry[];
}

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

/** List of every model slug present in the local Codex cache. Empty
 * array when the cache is unreadable. */
function listKnownCodexSlugs(): string[] {
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

/** True if the slug appears in the local Codex models cache. Returns
 * `true` when the cache cannot be read (missing / malformed) so a
 * broken cache never gates display - the fallback matches prior
 * behavior where no validation ran at all. Returns `false` only when
 * the cache is readable AND the slug is definitely not present. */
export function isKnownCodexModel(slug: string | null): boolean {
  if (!slug) return true;
  const known = listKnownCodexSlugs();
  if (known.length === 0) return true;
  return known.includes(slug);
}

/** The model's default reasoning level from the cache, or null when
 * the cache is unreadable or the slug is absent / carries no default.
 * Used by the session-token tooltip to show the effort Codex runs. */
export function getCodexModelDefaultEffort(slug: string): string | null {
  const cache = readModelsCache();
  if (!cache?.models) return null;
  for (const entry of cache.models) {
    if (entry.slug === slug) return entry.default_reasoning_level ?? null;
  }
  return null;
}
