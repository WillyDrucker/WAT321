import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../fs/atomicWrite";
import { WAT321_ROOT } from "../../wat321Paths";
import type { CodexCatalogEntry } from "./modelCatalog";

/**
 * Disk sidecar for the live Codex model catalog.
 *
 * Why persist at all. The in-memory catalog only fills once the bridge
 * has spawned an app-server, which happens on the first dispatch, never
 * at activate (see `EPIC_HANDSHAKE/index.ts`, "No activate-time codex
 * daemon spawn"). Without a sidecar the model picker in a freshly opened
 * window falls back to `~/.codex/models_cache.json`, the shared file
 * every codex binary on the machine overwrites with its own version's
 * catalog. That is precisely the wrong answer the catalog exists to
 * replace, and the user sees models appear and vanish between windows.
 *
 * Why this is not the "remember the richer list" idea we rejected. That
 * one merged a DIFFERENT binary's file into our view and would offer
 * slugs the running app-server 404s on. This stores one binary's own
 * answer under a key that identifies that binary: its resolved command
 * plus the exact `--version` line. A codex upgraded, downgraded, or
 * swapped for the extension-bundled one produces a different key, the
 * sidecar is ignored, and we fall back exactly as before. It can never
 * describe a binary we are not talking to.
 *
 * Best-effort throughout. A missing, unreadable, or mismatched sidecar
 * is a silent no-op that leaves validity failing open.
 */

/** Basename of the sidecar. Exported so `resetSettings.ts` can name it
 * in the Reset WAT321 sweep without duplicating the string: Reset wipes
 * `~/.wat321/` root files by name, not wholesale. */
export const CODEX_MODEL_CATALOG_FILENAME = "codex-model-catalog.json";

const CATALOG_PATH = join(WAT321_ROOT, CODEX_MODEL_CATALOG_FILENAME);

interface PersistedCatalog {
  /** Resolved spawn command the entries were read from. */
  binary: string;
  /** Raw `<command> --version` line. The upgrade-in-place guard: a
   * binary at the same path reporting a new version invalidates this. */
  version: string;
  entries: CodexCatalogEntry[];
}

/** Read the sidecar, or null when absent, unreadable, or written for a
 * different binary or version than the one we now resolve to. The
 * caller treats null as "no catalog" and falls back to the cache file. */
export function readPersistedCatalog(
  binary: string,
  version: string
): CodexCatalogEntry[] | null {
  if (!existsSync(CATALOG_PATH)) return null;
  try {
    const parsed = JSON.parse(
      readFileSync(CATALOG_PATH, "utf8")
    ) as Partial<PersistedCatalog>;
    if (parsed.binary !== binary || parsed.version !== version) return null;
    if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
      return null;
    }
    // Guard the one field every reader dereferences. A hand-edited or
    // truncated sidecar must not reach the picker as a row with no slug.
    const entries = parsed.entries.filter(
      (e) => typeof e?.slug === "string" && e.slug.length > 0
    );
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

/** Persist the catalog under the identity of the binary that produced
 * it. Best-effort: a failed write costs the next window a fallback to
 * the cache file, nothing more. */
export function writePersistedCatalog(
  binary: string,
  version: string,
  entries: readonly CodexCatalogEntry[]
): void {
  if (entries.length === 0) return;
  const payload: PersistedCatalog = {
    binary,
    version,
    entries: [...entries],
  };
  try {
    mkdirSync(WAT321_ROOT, { recursive: true });
    writeFileAtomic(CATALOG_PATH, JSON.stringify(payload, null, 2));
  } catch {
    // best-effort
  }
}
