import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./fs/atomicWrite";

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

/** Public-facing shape for the model + effort picker. Carries everything
 * the picker needs to render a row (display_name + description) and
 * everything the effort sub-picker needs after the user picks a model
 * (the supported effort list with per-effort descriptions). */
export interface CodexModelInfo {
  slug: string;
  displayName: string;
  description: string;
  defaultEffort: string | null;
  supportedEfforts: { effort: string; description: string }[];
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

/** Read the `model_reasoning_effort = "..."` key from
 * `~/.codex/config.toml`. Same scan strategy as `readCodexConfigModel`:
 * top-level only, stop at the first table header. Returns null when
 * the file is missing, the key is unset, or the value is not a string. */
export function readCodexConfigEffort(): string | null {
  return readTopLevelStringKey("model_reasoning_effort");
}

/** Read the `sandbox_mode = "..."` key from `~/.codex/config.toml`.
 * Common values: `read-only`, `workspace-write`, `danger-full-access`.
 * Returns null when unset. Used for read-only surfacing of Codex's
 * current sandbox state in the bridge widget tooltip. */
export function readCodexConfigSandbox(): string | null {
  return readTopLevelStringKey("sandbox_mode");
}

/** Read the `approval_policy = "..."` key from `~/.codex/config.toml`.
 * Common values: `never`, `untrusted`, `on-failure`. Distinct from
 * sandbox: approval gates apply_patch + tool calls; sandbox gates
 * shell + filesystem. Returns null when unset. */
export function readCodexConfigApproval(): string | null {
  return readTopLevelStringKey("approval_policy");
}

/** Generic top-level string key reader for `~/.codex/config.toml`.
 * Stops at the first `[section]` header so a profile-scoped key does
 * not shadow the top-level default. Quotes can be `"..."` or `'...'`. */
function readTopLevelStringKey(key: string): string | null {
  const configPath = join(homedir(), ".codex", "config.toml");
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf8");
    const re = new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`);
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) break;
      const m = re.exec(trimmed);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve the rich info for a model slug from the cache. Returns null
 * when the cache is unreadable or the slug is not present. Caller can
 * fall back to a slug-only display when null comes back. */
export function getCodexModelInfo(slug: string): CodexModelInfo | null {
  const cache = readModelsCache();
  if (!cache?.models) return null;
  for (const entry of cache.models) {
    if (entry.slug !== slug) continue;
    return modelEntryToInfo(entry);
  }
  return null;
}

/** All models the user should see in the picker. Filters by
 * `visibility === "list"` (matching Codex's own UI behavior - hidden
 * models like preview slugs stay out of the dropdown), and sorts by
 * `priority` ascending so the recommended model lands first. */
export function listSelectableCodexModels(): CodexModelInfo[] {
  const cache = readModelsCache();
  if (!cache?.models) return [];
  const selectable = cache.models.filter((m) => m.visibility === "list");
  selectable.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  return selectable
    .map((m) => modelEntryToInfo(m))
    .filter((m): m is CodexModelInfo => m !== null);
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

/** Write a top-level string key to `~/.codex/config.toml`. Replaces the
 * line if the key already exists in the header (before any
 * `[section]` block); appends a new line above the first section
 * otherwise. Atomic via tmp + rename so a partial write never leaves
 * Codex with a torn config.
 *
 * Returns true on success. Returns false on rename failure (Windows
 * EBUSY when Codex itself has the file open is the realistic case);
 * the caller can surface a "try again with Codex idle" hint. */
export function writeCodexConfigTopLevelKey(
  key: string,
  value: string
): boolean {
  const configPath = join(homedir(), ".codex", "config.toml");
  let content = "";
  if (existsSync(configPath)) {
    try {
      content = readFileSync(configPath, "utf8");
    } catch {
      return false;
    }
  }
  const lines = content.length > 0 ? content.split("\n") : [];
  // Quote the value as a basic TOML string. Escape backslash + quote.
  const quoted = `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const newLine = `${key} = ${quoted}`;

  // Locate the first `[section]` header - top-level keys must come before it.
  let firstSection = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      firstSection = i;
      break;
    }
  }

  // Replace existing line if present in the header range.
  const keyRegex = new RegExp(`^${key}\\s*=`);
  let replaced = false;
  for (let i = 0; i < firstSection; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("#")) continue;
    if (keyRegex.test(trimmed)) {
      lines[i] = newLine;
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    // Insert above the first section header. If the line right above
    // the section is non-blank, add a blank separator first so the
    // resulting file keeps a clean visual gap between top-level keys
    // and the first table.
    const insertAt = firstSection;
    if (insertAt > 0 && lines[insertAt - 1].trim().length > 0) {
      lines.splice(insertAt, 0, newLine, "");
    } else {
      lines.splice(insertAt, 0, newLine);
    }
  }

  return writeFileAtomic(configPath, lines.join("\n"));
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
