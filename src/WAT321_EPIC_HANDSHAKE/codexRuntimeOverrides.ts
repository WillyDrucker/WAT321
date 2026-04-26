import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import {
  CODEX_EFFORT_FLAG_PATH,
  CODEX_FULL_ACCESS_FLAG_PATH,
  CODEX_MODEL_FLAG_PATH,
} from "./constants";

/**
 * Read/write helpers for the three runtime override flags that
 * `turnRunner` passes through on every `turn/start`:
 *
 *   - sandbox        (CODEX_FULL_ACCESS_FLAG_PATH, presence-only)
 *   - model          (CODEX_MODEL_FLAG_PATH, body = slug)
 *   - effort         (CODEX_EFFORT_FLAG_PATH, body = level)
 *
 * Per-turn override is the entire mechanism. `thread/start` passes
 * permissive defaults so the thread itself never restricts; the
 * authoritative state for any given turn comes from these flag files
 * being read at `turn/start` time. Codex enforces whatever it's told
 * per-turn (verified via probe: turn_context records the override AND
 * the tool router rejects out-of-policy operations).
 *
 * Settings drive the default flag-file state on tier activate. The
 * Codex Defaults menu picker writes flags directly (overrides until
 * next reload). All flags are best-effort I/O - missed reads/writes
 * fall back to "no override" which is safe (Codex thread default).
 */

// -----------------------------------------------------------------
// Sandbox
// -----------------------------------------------------------------

export type CodexSandboxState = "full-access" | "read-only";

export function readCodexSandboxOverride(): CodexSandboxState {
  return existsSync(CODEX_FULL_ACCESS_FLAG_PATH) ? "full-access" : "read-only";
}

export function writeCodexSandboxOverride(state: CodexSandboxState): void {
  try {
    if (state === "full-access") {
      writeFileAtomic(
        CODEX_FULL_ACCESS_FLAG_PATH,
        new Date().toISOString()
      );
    } else if (existsSync(CODEX_FULL_ACCESS_FLAG_PATH)) {
      unlinkSync(CODEX_FULL_ACCESS_FLAG_PATH);
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
export function readCodexModelOverride(): string | null {
  if (!existsSync(CODEX_MODEL_FLAG_PATH)) return null;
  try {
    const raw = readFileSync(CODEX_MODEL_FLAG_PATH, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function writeCodexModelOverride(slug: string | null): void {
  try {
    if (slug === null || slug.length === 0) {
      if (existsSync(CODEX_MODEL_FLAG_PATH)) unlinkSync(CODEX_MODEL_FLAG_PATH);
    } else {
      writeFileAtomic(CODEX_MODEL_FLAG_PATH, slug);
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
export function readCodexEffortOverride(): CodexEffortLevel | null {
  if (!existsSync(CODEX_EFFORT_FLAG_PATH)) return null;
  try {
    const raw = readFileSync(CODEX_EFFORT_FLAG_PATH, "utf8").trim();
    return VALID_EFFORTS.has(raw) ? (raw as CodexEffortLevel) : null;
  } catch {
    return null;
  }
}

export function writeCodexEffortOverride(level: CodexEffortLevel | null): void {
  try {
    if (level === null) {
      if (existsSync(CODEX_EFFORT_FLAG_PATH)) {
        unlinkSync(CODEX_EFFORT_FLAG_PATH);
      }
    } else {
      writeFileAtomic(CODEX_EFFORT_FLAG_PATH, level);
    }
  } catch {
    // best-effort
  }
}
