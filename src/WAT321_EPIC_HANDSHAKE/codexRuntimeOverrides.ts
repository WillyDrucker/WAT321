import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { CodexEffortLevel } from "../engine/bridgeTypes";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { listKnownCodexEffortLevels } from "../shared/providers/codex/models";
import {
  codexEffortFlagPath,
  codexModelFlagPath,
  codexSandboxFlagPath,
  codexSandboxTouchedFlagPath,
} from "./constants";

/**
 * Read/write helpers for the three runtime override flags that
 * `turnRunner` passes through on every `turn/start`:
 *
 *   - sandbox        (codex-sandbox.<wsHash>.flag, presence-only)
 *   - model          (codex-model.<wsHash>.flag, body = slug)
 *   - effort         (codex-effort.<wsHash>.flag, body = level)
 *
 * All three are workspace-scoped: each VS Code workspace carries its
 * own preferences so two windows on the same machine (test instance
 * + main dev, project A + project B) do not bleed settings into each
 * other. The wsHash partitioning mirrors the existing in-flight /
 * processing / paused flags.
 *
 * Per-turn override is the entire mechanism. `thread/start` passes
 * permissive defaults so the thread itself never restricts - the
 * authoritative state for any given turn comes from these flag files
 * being read at `turn/start` time. Codex enforces whatever it's told
 * per-turn (verified via probe: turn_context records the override AND
 * the tool router rejects out-of-policy operations).
 *
 * No persistent settings back these. The Codex Session Settings menu
 * picker writes flags directly. All flags are best-effort I/O - missed
 * reads/writes fall back to "no override" which is safe (Codex thread
 * default).
 */

// -----------------------------------------------------------------
// Sandbox
// -----------------------------------------------------------------

export type CodexSandboxState = "full-access" | "read-only";

export function readCodexSandboxOverride(wsHash: string): CodexSandboxState {
  return existsSync(codexSandboxFlagPath(wsHash)) ? "full-access" : "read-only";
}

export function writeCodexSandboxOverride(
  wsHash: string,
  state: CodexSandboxState
): void {
  const path = codexSandboxFlagPath(wsHash);
  try {
    if (state === "full-access") {
      writeFileAtomic(path, new Date().toISOString());
    } else if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // best-effort
  }
  // Mark this workspace's sandbox slot as user-touched so the picker's
  // "*default*" badge stops appearing on read-only - the user is now
  // showing a deliberate choice, not a pristine schema default. The
  // sentinel is write-once and stays put until Reset wipes ~/.wat321.
  try {
    const touched = codexSandboxTouchedFlagPath(wsHash);
    if (!existsSync(touched)) {
      writeFileAtomic(touched, new Date().toISOString());
    }
  } catch {
    // best-effort
  }
}

/** True once the user has explicitly picked sandbox at least once for
 * this workspace. Used by the picker to suppress the "*default*" tag
 * on a workspace where the user has actively chosen read-only. */
export function sandboxHasBeenTouched(wsHash: string): boolean {
  return existsSync(codexSandboxTouchedFlagPath(wsHash));
}

// -----------------------------------------------------------------
// Model
// -----------------------------------------------------------------

/** Read the active model override slug, or null when no override is
 * set (Codex uses the thread / config.toml default in that case). */
export function readCodexModelOverride(wsHash: string): string | null {
  const path = codexModelFlagPath(wsHash);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function writeCodexModelOverride(
  wsHash: string,
  slug: string | null
): void {
  const path = codexModelFlagPath(wsHash);
  try {
    if (slug === null || slug.length === 0) {
      if (existsSync(path)) unlinkSync(path);
    } else {
      writeFileAtomic(path, slug);
    }
  } catch {
    // best-effort
  }
}

// -----------------------------------------------------------------
// Effort
// -----------------------------------------------------------------


/** Every level Codex has shipped to date. This is a FLOOR, never a
 * ceiling: the gate below unions it with whatever the app-server or the
 * cache reports, so a level OpenAI adds later still flows through.
 *
 * It must stay a floor because the effort flag file is a persisted user
 * preference and the catalog is empty until the app-server finishes its
 * first `initialize`. A gate that narrowed to the live catalog would
 * silently discard a saved `ultra` whenever a fresh window read the
 * flag before prewarm completed, dropping the user back to the model's
 * default effort with no visible cause. Sending a level the target
 * model rejects surfaces a turn error the user can see. Silently
 * downgrading their reasoning depth does not. */
const BUILTIN_EFFORTS: ReadonlySet<string> = new Set<string>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

/** Sanitize a persisted effort flag against garbage. Unions the built-in
 * floor with the levels the running Codex advertises.
 *
 * This does NOT authorize a model pairing: `ultra` passes here yet is
 * absent from 5.6 Luna. The effort picker owns that gate, narrowing its
 * rows to the SELECTED model's own advertised levels. Module-private,
 * because the flag reader below is its only caller. */
function isCodexEffortLevel(value: string): boolean {
  if (value.length === 0) return false;
  if (BUILTIN_EFFORTS.has(value)) return true;
  return listKnownCodexEffortLevels().has(value);
}

/** Read the active effort override, or null when unset. Validates so a
 * stale flag with garbage content does not flow through to
 * `turn/start`. */
export function readCodexEffortOverride(
  wsHash: string
): CodexEffortLevel | null {
  const path = codexEffortFlagPath(wsHash);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    return isCodexEffortLevel(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeCodexEffortOverride(
  wsHash: string,
  level: CodexEffortLevel | null
): void {
  const path = codexEffortFlagPath(wsHash);
  try {
    if (level === null) {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    } else {
      writeFileAtomic(path, level);
    }
  } catch {
    // best-effort
  }
}

