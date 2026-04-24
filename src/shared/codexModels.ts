import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read-only accessor for `~/.codex/models_cache.json`, the
 * authoritative list of model slugs Codex CLI recognizes locally.
 * Used to detect bridge sessions whose stored `session_meta.model` has
 * drifted out of the installed CLI's known set - a class of failure
 * that surfaces as a 404 from the API on the next `thread/resume`.
 *
 * The cache refreshes on Codex CLI upgrades; our validation
 * automatically reflects the current installed set without any
 * WAT321-side change when OpenAI renames or retires a model.
 *
 * Safe to call on every dispatch: the file is typically under 4KB and
 * parsed in a fraction of a ms. Failures collapse to `null` / `true`
 * so a missing or unreadable cache never gates legitimate work.
 */

const MODELS_CACHE_PATH = join(homedir(), ".codex", "models_cache.json");

interface ModelsCacheEntry {
  slug?: string;
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
 * array when the cache is unreadable. Used by the repair picker to
 * suggest a replacement slug, and by diagnostics. */
export function listKnownCodexSlugs(): string[] {
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
 * broken cache never gates a dispatch - the fallback matches prior
 * behavior where no validation ran at all. Returns `false` only when
 * the cache is readable AND the slug is definitely not present. */
export function isKnownCodexModel(slug: string | null): boolean {
  if (!slug) return true;
  const known = listKnownCodexSlugs();
  if (known.length === 0) return true;
  return known.includes(slug);
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

/** Pick a repair target for an invalid model slug. Priority:
 *   1. Codex CLI's configured default (from config.toml) if valid
 *   2. First entry in models_cache.json (a model Codex definitely
 *      supports on this machine)
 *   3. null - no safe repair possible; caller falls back to Reset
 * Validating the config.toml default before picking it protects
 * against the case where config itself stores the bad slug (the
 * likely origin of the drift in the first place). */
export function preferredRepairSlug(): string | null {
  const configDefault = readCodexConfigModel();
  if (configDefault && isKnownCodexModel(configDefault)) return configDefault;
  const known = listKnownCodexSlugs();
  return known.length > 0 ? known[0] : null;
}
