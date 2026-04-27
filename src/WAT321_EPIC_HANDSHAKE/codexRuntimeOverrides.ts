import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import {
  codexEffortFlagPath,
  codexModelFlagPath,
  codexSandboxFlagPath,
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
