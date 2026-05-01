import { existsSync, unlinkSync } from "node:fs";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { ADAPTIVE_FLAG_PATH, FIRE_AND_FORGET_FLAG_PATH } from "./constants";

/**
 * Three-way wait mode for the Epic Handshake bridge:
 *   - `standard`        - flag files absent. MCP tool blocks up to
 *                         `timeout_sec` (default 120s).
 *   - `adaptive`        - `adaptive.flag` present. MCP tool blocks
 *                         while the dispatcher's heartbeat is fresh,
 *                         hard cap 5 min.
 *   - `fire-and-forget` - `fire-and-forget.flag` present. MCP tool
 *                         returns immediately; reply lands in inbox.
 *
 * Exactly one flag (or neither) at a time under `applyWaitMode`'s
 * clear-then-set discipline. Persisted across VS Code restarts. The
 * tier's activate hook applies the user's `defaultWaitMode` setting
 * only when no flag is currently on disk (Standard / fresh install).
 * An existing flag (set by this window's prior session, this window's
 * menu click, or another VS Code window) is respected; the global
 * flag-file location means clobbering it would silently flip another
 * window's mode. Explicit settings-change events force-apply.
 */

export type WaitMode = "standard" | "adaptive" | "fire-and-forget";

export function isAdaptive(): boolean {
  return existsSync(ADAPTIVE_FLAG_PATH);
}

/** Resolve the current mode from flag files. */
export function currentWaitMode(): WaitMode {
  if (existsSync(FIRE_AND_FORGET_FLAG_PATH)) return "fire-and-forget";
  if (existsSync(ADAPTIVE_FLAG_PATH)) return "adaptive";
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

/** Clear both flags first, then set the target. Prevents a transient
 * "both present" state that a sequential set-A-then-clear-B ordering
 * would expose (a consumer reading during that window would see
 * inconsistent mode). The "both absent" transient that remains is
 * harmless because it's the Standard mode state anyway. */
export function applyWaitMode(mode: WaitMode): void {
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
  clear(FIRE_AND_FORGET_FLAG_PATH);
  clear(ADAPTIVE_FLAG_PATH);
  if (mode === "fire-and-forget") set(FIRE_AND_FORGET_FLAG_PATH);
  else if (mode === "adaptive") set(ADAPTIVE_FLAG_PATH);
  // mode === "standard" leaves both cleared - that's the Standard state.
}

/** Parse the user-facing `wat321.epicHandshake.defaultWaitMode`
 * setting value into our internal enum. The setting now exposes only
 * Adaptive and Fire-and-Forget; users who carried over a "Standard"
 * value from earlier versions migrate to Adaptive on activate. */
export function parseDefaultWaitMode(raw: string | undefined): WaitMode {
  if (raw === "Fire-and-Forget") return "fire-and-forget";
  return "adaptive";
}

/** Apply the user's default wait mode at tier activation. Subsequent
 * user toggles via the menu override this until the next restart. */
export function applyDefaultWaitMode(mode: WaitMode): void {
  applyWaitMode(mode);
}
