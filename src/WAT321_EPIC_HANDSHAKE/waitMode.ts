import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { workspaceHash } from "../shared/workspaceHash";
import { adaptiveFlagPath, EPIC_HANDSHAKE_DIR, fireAndForgetFlagPath } from "./constants";

/**
 * Three-way wait mode for the Epic Handshake bridge:
 *   - `standard`        - flag files absent. MCP tool blocks up to
 *                         `timeout_sec` (default 120s). Dispatcher
 *                         hard cap 5 min.
 *   - `adaptive`        - per-workspace `adaptive.<wsHash>.flag`
 *                         present. MCP tool blocks while the
 *                         dispatcher's heartbeat is fresh, hard cap
 *                         30 min on both MCP and dispatcher sides
 *                         (kept in sync so neither interrupts the
 *                         other early).
 *   - `fire-and-forget` - per-workspace `fire-and-forget.<wsHash>.flag`
 *                         present. MCP tool returns immediately;
 *                         reply lands in inbox. Dispatcher runs with
 *                         all timers disabled.
 *
 * Per-workspace partition: both flags carry the workspace-hash suffix
 * so toggling the mode in one VS Code window does not flip the mode
 * in a sibling window on the same machine. Matches the partitioning
 * pattern of `inFlightFlagPath` / `processingFlagPath` / etc.
 * Account-global root-level flag files are retired via
 * `LEGACY_FLAG_PATHS` on activate.
 *
 * Mode resolution precedence at the MCP boundary: per-call `args`
 * (FF / adaptive booleans on `wat321_ask`) win over sticky flag
 * files. The selected mode is written into the envelope as
 * `wait_mode` so the dispatcher honors the per-call value, not its
 * own reading of the sticky flag.
 *
 * Exactly one flag (or neither) at a time under `applyWaitMode`'s
 * clear-then-set discipline. Persisted across VS Code restarts. The
 * tier's activate hook applies Adaptive as the fixed default when no
 * flag is currently on disk (fresh window).
 */

export type WaitMode = "standard" | "adaptive" | "fire-and-forget";

function hashFor(workspacePath: string): string {
  return workspaceHash(workspacePath);
}

export function isAdaptive(workspacePath: string): boolean {
  return existsSync(adaptiveFlagPath(hashFor(workspacePath)));
}

/** Resolve the current mode from the per-workspace flag files. */
export function currentWaitMode(workspacePath: string): WaitMode {
  const hash = hashFor(workspacePath);
  if (existsSync(fireAndForgetFlagPath(hash))) return "fire-and-forget";
  if (existsSync(adaptiveFlagPath(hash))) return "adaptive";
  return "standard";
}

/** Binary toggle between Adaptive and Fire-and-Forget. The Standard
 * (fixed 2-min) mode still exists internally for legacy/diagnostic
 * use but is intentionally unreachable from the menu - if the runtime
 * observes it, the next toggle moves to Adaptive as the modern default. */
export function nextWaitMode(current: WaitMode): WaitMode {
  return current === "fire-and-forget" ? "adaptive" : "fire-and-forget";
}

export function waitModeLabel(mode: WaitMode): string {
  switch (mode) {
    case "standard":
      return "STANDARD";
    case "adaptive":
      return "ADAPTIVE";
    case "fire-and-forget":
      return "FIRE & FORGET";
  }
}

/** Clear both per-workspace flags first, then set the target.
 * Prevents a transient "both present" state that a sequential
 * set-A-then-clear-B ordering would expose (a consumer reading
 * during that window would see inconsistent mode). The "both absent"
 * transient that remains is harmless because it is the Standard
 * mode state anyway. */
export function applyWaitMode(mode: WaitMode, workspacePath: string): void {
  const hash = hashFor(workspacePath);
  // Ensure the EH dir exists before any flag write. Activate-time
  // calls hit before other EH initialization that would create the
  // directory, and `writeFileAtomic` returns false silently on ENOENT,
  // which would leave both flags absent and the menu reading STANDARD.
  try {
    if (!existsSync(EPIC_HANDSHAKE_DIR)) {
      mkdirSync(EPIC_HANDSHAKE_DIR, { recursive: true });
    }
  } catch {
    // best-effort - if mkdir fails the writes below also fail and the
    // caller's next refresh observes the actual on-disk state
  }
  const clear = (path: string): void => {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // best-effort
    }
  };
  const set = (path: string): void => {
    try {
      writeFileAtomic(path, new Date().toISOString());
    } catch {
      // best-effort; next refresh reflects whichever state the writes
      // actually achieved
    }
  };
  const ffPath = fireAndForgetFlagPath(hash);
  const adPath = adaptiveFlagPath(hash);
  clear(ffPath);
  clear(adPath);
  if (mode === "fire-and-forget") set(ffPath);
  else if (mode === "adaptive") set(adPath);
  // mode === "standard" leaves both cleared - that's the Standard state.
}

/** Apply the activate-time default wait mode. Adaptive is the fixed
 * default - the user-facing `defaultWaitMode` setting is gone.
 * Subsequent runtime toggles via the menu override this until the
 * next restart. */
export function applyDefaultWaitMode(
  mode: WaitMode,
  workspacePath: string
): void {
  applyWaitMode(mode, workspacePath);
}
