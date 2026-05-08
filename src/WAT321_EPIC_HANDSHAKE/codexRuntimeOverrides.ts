import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import {
  codexEffortFlagPath,
  codexModelFlagPath,
  codexSandboxFlagPath,
  codexSandboxTouchedFlagPath,
  EPIC_HANDSHAKE_DIR,
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
 * permissive defaults so the thread itself never restricts; the
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

export type CodexEffortLevel = "low" | "medium" | "high" | "xhigh";

const VALID_EFFORTS: ReadonlySet<string> = new Set<string>([
  "low",
  "medium",
  "high",
  "xhigh",
]);

/** Read the active effort override, or null when unset. Validates
 * against the known enum so a stale flag with garbage content does
 * not flow through to `turn/start`. */
export function readCodexEffortOverride(
  wsHash: string
): CodexEffortLevel | null {
  const path = codexEffortFlagPath(wsHash);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    return VALID_EFFORTS.has(raw) ? (raw as CodexEffortLevel) : null;
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

// -----------------------------------------------------------------
// Reset support
// -----------------------------------------------------------------

/** Sweep every codex-{sandbox,model,effort,sandbox-touched} flag in
 * the EH dir, regardless of wsHash. Reset WAT321 leans on
 * `rmSync(~/.wat321/)` for the global wipe, but on Windows that
 * recursive remove can fail mid-tree if any file is locked (e.g. a
 * still-running channel.mjs holding `channel.log` open) and leave
 * sibling subtrees untouched. The codex override flags then survive
 * and the picker re-reads stale full-access / model overrides on the
 * next click - the user sees their pre-reset choice instead of the
 * platform read-only default. Calling this from EH's resetCleanup
 * before the disk wipe guarantees the override slate is clean even
 * when `rmSync` only partially completes. */
export function clearAllCodexOverrideFlags(): void {
  if (!existsSync(EPIC_HANDSHAKE_DIR)) return;
  let entries: string[];
  try {
    entries = readdirSync(EPIC_HANDSHAKE_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    if (
      name.startsWith("codex-sandbox.") ||
      name.startsWith("codex-sandbox-touched.") ||
      name.startsWith("codex-model.") ||
      name.startsWith("codex-effort.")
    ) {
      try {
        unlinkSync(join(EPIC_HANDSHAKE_DIR, name));
      } catch {
        // best-effort - reset must continue regardless
      }
    }
  }
}
