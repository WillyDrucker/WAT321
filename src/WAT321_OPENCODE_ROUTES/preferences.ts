import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../engine/fs/atomicWrite";
import { OPENCODE_ROUTES_DIR, PREFERENCES_PATH } from "./openCodeRoutesPaths";

/**
 * Runtime preferences for OpenCode Routes. Persists `activeInstanceId`
 * only - which catalog entry handles dispatch when the caller does not
 * pin one explicitly.
 *
 * Settings.json carries only the master `enabled` flag plus the local
 * endpoint URL. The instance catalog is hardcoded in
 * `shared/providers/opencode/catalog.ts`. Active-instance selection is
 * exclusively click-menu driven so users never hand-edit JSON.
 *
 * Atomic writes ensure channel.mjs reading mid-update never sees a
 * torn JSON parse.
 */

interface OpenCodeRoutesPreferences {
  /** Active instance id. Empty means "use the local instance" - a
   * sensible default when the user hasn't picked one yet. Driven by
   * the click-menu's Active Instance picker. */
  activeInstanceId: string;
}

const DEFAULT_PREFERENCES: OpenCodeRoutesPreferences = {
  activeInstanceId: "",
};

function ensureDir(): void {
  if (!existsSync(OPENCODE_ROUTES_DIR)) {
    mkdirSync(OPENCODE_ROUTES_DIR, { recursive: true });
  }
  const dir = dirname(PREFERENCES_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Load preferences, merging stored values over the defaults so a
 * partially-written file still produces a complete object. Extra
 * keys present in older on-disk shapes are dropped silently because
 * the spread is keyed on `OpenCodeRoutesPreferences`. */
export function readPreferences(): OpenCodeRoutesPreferences {
  if (!existsSync(PREFERENCES_PATH)) return { ...DEFAULT_PREFERENCES };
  try {
    const raw = readFileSync(PREFERENCES_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<OpenCodeRoutesPreferences>;
    return { ...DEFAULT_PREFERENCES, ...parsed };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Atomically write the entire preferences object. */
function writePreferences(prefs: OpenCodeRoutesPreferences): boolean {
  ensureDir();
  return writeFileAtomic(PREFERENCES_PATH, `${JSON.stringify(prefs, null, 2)}\n`);
}

/** Update a single preference key without disturbing the rest.
 * Reads the current file, applies the patch, writes atomically. */
export function updatePreference<K extends keyof OpenCodeRoutesPreferences>(
  key: K,
  value: OpenCodeRoutesPreferences[K]
): boolean {
  const current = readPreferences();
  current[key] = value;
  return writePreferences(current);
}
