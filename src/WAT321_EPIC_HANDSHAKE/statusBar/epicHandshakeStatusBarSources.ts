import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { waitModeFlashFlagPath } from "../epicHandshakePaths";

/**
 * Data sources the Epic Handshake widget reads each refresh tick
 * beyond the engine's bridge snapshot and the shared OpenCode dispatch
 * heartbeat (`shared/bridge/openCodeDispatchHeartbeat.ts`):
 *
 *   - Synthetic stage progression for OpenCode / Local LLM turns, the
 *     fallback while the engine's turn heartbeat has no latched stage
 *   - Wait-mode-flash sentinel (lazy-cleans the flag file when the
 *     2.5s window expires so a stale sentinel never rides into a
 *     later session)
 *
 * All readers are best-effort: missing files / parse errors fall
 * through to false so the 1Hz refresh loop never throws.
 */

/** Synthesize a Codex-style stage from elapsed time since the
 * OpenCode dispatch started, so the widget runs the same visual
 * rhythm during an OpenCode / Local turn that it does during a Codex
 * turn. Stays on `working` for the long tail of generation. */
export function syntheticOpenCodeStage(
  elapsedMs: number
): "dispatched" | "received" | "working" {
  if (elapsedMs < 3_000) return "dispatched";
  if (elapsedMs < 8_000) return "received";
  return "working";
}

const WAIT_MODE_FLASH_DURATION_MS = 2500;

/** True when inside the 2500ms wait-mode toggle flash window. Lazy-
 * unlinks the flag file once the window expires so a stale flash
 * sentinel from a prior session can't ride into the next tick. */
export function isWaitModeFlashActive(
  now: number,
  wsHash: string | null
): boolean {
  if (!wsHash) return false;
  const path = waitModeFlashFlagPath(wsHash);
  let start: number | null = null;
  try {
    if (!existsSync(path)) return false;
    const raw = readFileSync(path, "utf8").trim();
    const t = new Date(raw).getTime();
    start = Number.isFinite(t) ? t : null;
  } catch {
    return false;
  }
  if (start === null) return false;
  if (now - start < WAIT_MODE_FLASH_DURATION_MS) return true;
  try {
    unlinkSync(path);
  } catch {
    // best-effort
  }
  return false;
}
