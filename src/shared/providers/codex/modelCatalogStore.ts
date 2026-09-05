import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../../engine/fs/atomicWrite";
import { WAT321_ROOT } from "../../../engine/wat321Paths";
import type { CodexCatalogEntry, CodexModelUpgrade } from "./modelCatalog";

/**
 * Disk sidecar for the live Codex model catalog.
 *
 * Why persist at all. The in-memory catalog only fills once the bridge
 * has spawned an app-server, which happens on the first dispatch, never
 * at activate (see `WAT321_EPIC_HANDSHAKE/index.ts`, "No activate-time codex
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
 * Identity is not freshness. The backend can switch a model on for this
 * account under an unchanged binary, so the sidecar also records WHEN
 * the answer was given and the picker re-asks once that is old.
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
  /** Epoch ms of the app-server's answer. */
  fetchedAt: number;
  entries: CodexCatalogEntry[];
}

interface PersistedCatalogRead {
  entries: CodexCatalogEntry[];
  /** 0 when the sidecar predates the stamp. Reads as an unknown age, so
   * the next picker open re-asks and restamps it. */
  fetchedAt: number;
}

/** A sidecar written before retirement pointers existed has no
 * `upgrade` key at all. Readers test `=== null`, so absent must become
 * null rather than undefined. */
function normalizeUpgrade(raw: unknown): CodexModelUpgrade | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { model, retirementAtMs } = raw as {
    model?: unknown;
    retirementAtMs?: unknown;
  };
  if (typeof model !== "string" || model.length === 0) return null;
  return {
    model,
    retirementAtMs:
      typeof retirementAtMs === "number" && Number.isFinite(retirementAtMs)
        ? retirementAtMs
        : null,
  };
}

/** Read the sidecar, or null when absent, unreadable, or written for a
 * different binary or version than the one we now resolve to. The
 * caller treats null as "no catalog" and falls back to the cache file. */
export function readPersistedCatalog(
  binary: string,
  version: string
): PersistedCatalogRead | null {
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
    const entries = parsed.entries
      .filter((e) => typeof e?.slug === "string" && e.slug.length > 0)
      .map((e) => ({ ...e, upgrade: normalizeUpgrade(e.upgrade) }));
    if (entries.length === 0) return null;
    const fetchedAt =
      typeof parsed.fetchedAt === "number" &&
      Number.isFinite(parsed.fetchedAt) &&
      parsed.fetchedAt > 0
        ? parsed.fetchedAt
        : 0;
    return { entries, fetchedAt };
  } catch {
    return null;
  }
}

/** Persist the catalog under the identity of the binary that produced
 * it, stamped with when it answered. Best-effort: a failed write costs
 * the next window a fallback to the cache file, nothing more. */
export function writePersistedCatalog(
  binary: string,
  version: string,
  entries: readonly CodexCatalogEntry[],
  fetchedAt: number
): void {
  if (entries.length === 0) return;
  const payload: PersistedCatalog = {
    binary,
    version,
    fetchedAt,
    entries: [...entries],
  };
  try {
    mkdirSync(WAT321_ROOT, { recursive: true });
    writeFileAtomic(CATALOG_PATH, JSON.stringify(payload, null, 2));
  } catch {
    // best-effort
  }
}
