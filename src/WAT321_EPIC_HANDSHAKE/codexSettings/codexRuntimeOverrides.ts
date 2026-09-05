import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { CodexEffortLevel } from "../../engine/bridgeTypes";
import { writeFileAtomic } from "../../engine/fs/atomicWrite";
import { listKnownCodexEffortLevels } from "../../shared/providers/codex/models";
import {
  codexEffortFlagPath,
  codexModelFlagPath,
  codexSandboxFlagPath,
  codexSandboxTouchedFlagPath,
} from "../epicHandshakePaths";

/**
 * The sandbox override flag, plus the legacy-sweep readers that carry
 * a workspace-scoped model or effort flag into the session record.
 *
 * Sandbox is workspace-scoped and stays that way: it is a safety
 * posture for a folder, not a property of one conversation. Each VS
 * Code workspace carries its own, so a test instance and a main dev
 * window do not bleed into each other.
 *
 * Per-turn override is the entire mechanism. `thread/start` creates the
 * thread at the maximum ceiling and the authoritative policy for any
 * given turn is read at `turn/start` time. That is what lets a user dial
 * down for one turn and back up for the next with no thread reset
 * (verified via probe: turn_context records the override AND the tool
 * router rejects out-of-policy operations).
 *
 * Model and effort are per-session fields on `BridgeThreadRecord`,
 * owned by `codexSessionSettings.ts`: a workspace-scoped pin would
 * bleed across every session in a folder and outlive the session it
 * was chosen for. The readers below exist only for the legacy sweep.
 *
 * All flags are best-effort I/O. A missed read falls back to "no
 * override", which is the safe direction.
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
// Retired model + effort flags: migration readers only
//
// These two were per-WORKSPACE, which meant one pin bled across every
// session in a folder and outlived the session it was chosen for. They
// are now per-SESSION fields on `BridgeThreadRecord`. See
// `codexSessionSettings.ts`.
//
// The readers survive so `migrateLegacyPin` can adopt a choice an
// existing user already made, once, before the flags are swept. There
// are deliberately no writers left: nothing may create these again.
// -----------------------------------------------------------------

/** Read a retired per-workspace model flag. Migration only. */
export function readLegacyCodexModelFlag(wsHash: string): string | null {
  const path = codexModelFlagPath(wsHash);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Delete both retired flags for a workspace. Called once the record
 * has absorbed them, so a later downgrade cannot resurrect a stale
 * pin. Best-effort: a failure here only means we migrate again next
 * time, which is idempotent. */
export function clearLegacyCodexPinFlags(wsHash: string): void {
  for (const path of [codexModelFlagPath(wsHash), codexEffortFlagPath(wsHash)]) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // best-effort
    }
  }
}


/** Every level Codex has shipped to date. This is a FLOOR, never a
 * ceiling: the gate below unions it with whatever the app-server or the
 * cache reports, so a level OpenAI adds later still flows through.
 *
 * It must stay a floor because the session's effort is a persisted user
 * preference and the catalog is empty until the app-server finishes its
 * first `initialize`. A gate that narrowed to the live catalog would
 * silently discard a saved `ultra` whenever a fresh window read the
 * record before prewarm completed, dropping the user back to the model's
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

/** Sanitize a persisted effort against garbage. Unions the built-in
 * floor with the levels the running Codex advertises.
 *
 * This does NOT authorize a model pairing: `ultra` passes here yet is
 * absent from 5.6 Luna. The effort picker owns that gate, narrowing its
 * rows to the SELECTED model's own advertised levels. */
export function isCodexEffortLevel(value: string): boolean {
  if (value.length === 0) return false;
  if (BUILTIN_EFFORTS.has(value)) return true;
  return listKnownCodexEffortLevels().has(value);
}

/** Read a retired per-workspace effort flag. Migration only. */
export function readLegacyCodexEffortFlag(
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

