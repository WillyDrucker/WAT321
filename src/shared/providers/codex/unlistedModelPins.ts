import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../../engine/fs/atomicWrite";
import { WAT321_ROOT } from "../../../engine/wat321Paths";

/**
 * Model slugs the user pinned by typing them while no app-server listed
 * them. The escape hatch for a model OpenAI has enabled for the account
 * but Codex keeps out of its own picker, or has not sent to this
 * machine yet (a staged rollout lists a model for some accounts first).
 *
 * A pin makes `isKnownCodexModel` say yes, so pre-flight lets the turn
 * reach the API and the API gives the real answer. A pin is forgotten
 * the moment a catalog sync lists the slug, since the catalog then
 * vouches for it, and Reset WAT321 sweeps the file.
 *
 * Machine-wide, not per workspace: whether an account can run a model
 * is not a property of a folder. Best-effort I/O throughout.
 */

/** Basename of the pins file. Exported so `resetSettings.ts` can name
 * it in the Reset WAT321 sweep. */
export const CODEX_UNLISTED_PINS_FILENAME = "codex-unlisted-models.json";

const PINS_PATH = join(WAT321_ROOT, CODEX_UNLISTED_PINS_FILENAME);

interface PinsFile {
  slugs: string[];
}

function readPins(): string[] {
  if (!existsSync(PINS_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(PINS_PATH, "utf8")) as Partial<PinsFile>;
    if (!Array.isArray(parsed.slugs)) return [];
    return parsed.slugs.filter(
      (s): s is string => typeof s === "string" && s.length > 0
    );
  } catch {
    return [];
  }
}

function writePins(slugs: string[]): void {
  const payload: PinsFile = { slugs };
  try {
    mkdirSync(WAT321_ROOT, { recursive: true });
    writeFileAtomic(PINS_PATH, JSON.stringify(payload, null, 2));
  } catch {
    // best-effort
  }
}

/** Every slug the user has pinned by hand, oldest first. */
export function listUnlistedPins(): string[] {
  return readPins();
}

export function hasUnlistedPin(slug: string): boolean {
  return readPins().includes(slug);
}

/** Idempotent. Re-pinning a slug keeps its place in the list. */
export function rememberUnlistedPin(slug: string): void {
  const pins = readPins();
  if (pins.includes(slug)) return;
  writePins([...pins, slug]);
}

export function forgetUnlistedPin(slug: string): void {
  const pins = readPins();
  if (!pins.includes(slug)) return;
  writePins(pins.filter((s) => s !== slug));
}
