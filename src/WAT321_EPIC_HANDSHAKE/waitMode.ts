import { existsSync, unlinkSync, writeFileSync } from "node:fs";
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
 * clear-then-set discipline. Persisted across VS Code restarts; the
 * tier's activate hook applies the user's `defaultWaitMode` setting
 * once on startup.
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

export function nextWaitMode(current: WaitMode): WaitMode {
  switch (current) {
    case "standard":
      return "adaptive";
    case "adaptive":
      return "fire-and-forget";
    case "fire-and-forget":
      return "standard";
  }
}

export function waitModeLabel(mode: WaitMode): string {
  switch (mode) {
    case "standard":
      return "Standard (2 min)";
    case "adaptive":
      return "Adaptive (progress-aware)";
    case "fire-and-forget":
      return "Fire and forget";
  }
}

export function waitModeDetail(mode: WaitMode): string {
  switch (mode) {
    case "standard":
      return "Claude blocks up to 2 min per prompt. Fixed timeout.";
    case "adaptive":
      return "Claude waits while Codex is demonstrably working (heartbeat-driven). Cuts on stall, hard cap 5 min.";
    case "fire-and-forget":
      return "Claude's tool returns immediately; reply lands in inbox when ready.";
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
      writeFileSync(path, new Date().toISOString(), "utf8");
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
 * setting value into our internal enum. Unknown values fall back
 * to standard. */
export function parseDefaultWaitMode(raw: string | undefined): WaitMode {
  switch (raw) {
    case "Adaptive":
      return "adaptive";
    case "Fire-and-Forget":
      return "fire-and-forget";
    default:
      return "standard";
  }
}

/** Apply the user's default wait mode at tier activation. Subsequent
 * user toggles via the menu override this until the next restart. */
export function applyDefaultWaitMode(mode: WaitMode): void {
  applyWaitMode(mode);
}
