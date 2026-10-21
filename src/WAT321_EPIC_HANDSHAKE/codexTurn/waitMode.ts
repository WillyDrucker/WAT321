import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { writeFileAtomic } from "../../engine/fs/atomicWrite";
import type { BridgeWaitMode } from "../../engine/bridgeTypes";
import { EPIC_HANDSHAKE_DIR } from "../../engine/wat321Paths";
import { workspaceHash } from "../../engine/workspaceHash";
import { adaptiveFlagPath, fireAndForgetFlagPath } from "../epicHandshakePaths";

/**
 * Three-way wait mode for the Epic Handshake bridge, persisted as
 * per-workspace flag files so a sibling VS Code window keeps its own:
 *   - `standard`        no flag. The MCP tool blocks up to
 *                       `timeout_sec` (default 120s), dispatcher hard
 *                       cap 5 min.
 *   - `adaptive`        `adaptive.<wsHash>.flag`. The MCP tool blocks
 *                       while the dispatcher heartbeat is fresh, hard
 *                       cap 30 min on both sides so neither interrupts
 *                       the other early.
 *   - `fire-and-forget` `fire-and-forget.<wsHash>.flag`. The MCP tool
 *                       returns at once, the reply lands in the inbox,
 *                       the dispatcher runs with all timers disabled.
 *
 * Per-call `wat321_ask` args win over the sticky flag and travel in the
 * envelope as `wait_mode`, so the dispatcher honors the per-call value.
 * `applyWaitMode` keeps at most one flag on disk, and the tier applies
 * Adaptive on activate when a fresh window has none. Account-global
 * root-level flags are retired via `LEGACY_FLAG_PATHS` on activate.
 */

function hashFor(workspacePath: string): string {
  return workspaceHash(workspacePath);
}

export function isAdaptive(workspacePath: string): boolean {
  return existsSync(adaptiveFlagPath(hashFor(workspacePath)));
}

/** Resolve the current mode from the per-workspace flag files. */
export function currentWaitMode(workspacePath: string): BridgeWaitMode {
  const hash = hashFor(workspacePath);
  if (existsSync(fireAndForgetFlagPath(hash))) return "fire-and-forget";
  if (existsSync(adaptiveFlagPath(hash))) return "adaptive";
  return "standard";
}

/** Binary toggle between Adaptive and Fire-and-Forget. The Standard
 * (fixed 2-min) mode still exists internally for legacy/diagnostic
 * use but is intentionally unreachable from the menu - if the runtime
 * observes it, the next toggle moves to Adaptive as the modern default. */
export function nextWaitMode(current: BridgeWaitMode): BridgeWaitMode {
  return current === "fire-and-forget" ? "adaptive" : "fire-and-forget";
}

export function waitModeLabel(mode: BridgeWaitMode): string {
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
export function applyWaitMode(mode: BridgeWaitMode, workspacePath: string): void {
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
      // best-effort - next refresh reflects whichever state the writes
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
