import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { openCodeRoutesStateDir } from "../shared/wat321Paths";
import { waitModeFlashFlagPath } from "./constants";

/**
 * Data sources the Epic Handshake widget reads each refresh tick:
 *
 *   - OpenCode / Local LLM dispatch heartbeat (for the OC-in-flight
 *     animation when no Codex turn is active)
 *   - Synthetic stage progression for OC/Local turns (the unified
 *     bridge handlers don't emit real stage transitions yet)
 *   - Wait-mode-flash sentinel (lazy-cleans the flag file when the
 *     2.5s window expires so a stale sentinel never rides into a
 *     later session)
 *
 * All readers are best-effort: missing files / parse errors fall
 * through to null/false so the 1Hz refresh loop never throws.
 */

export interface OpenCodeHeartbeatActivity {
  startedAtMs: number;
}

/** Read the OpenCode/Local dispatch heartbeat for this workspace.
 * The state dir is already per-client so no per-instance suffix is
 * needed. Null when no workspace is active or the file is missing /
 * malformed. */
export function readOpenCodeHeartbeatActivity(
  wsHash: string | null
): OpenCodeHeartbeatActivity | null {
  if (!wsHash) return null;
  const path = join(openCodeRoutesStateDir(), "heartbeat.json");
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length === 0) return null;
    const parsed = JSON.parse(raw) as { startedAt?: unknown };
    if (typeof parsed.startedAt !== "string") return null;
    const t = new Date(parsed.startedAt).getTime();
    if (!Number.isFinite(t)) return null;
    return { startedAtMs: t };
  } catch {
    return null;
  }
}

/** Synthesize a Codex-style stage from elapsed time since the
 * OpenCode dispatch started. The unified bridge's OC/Local handlers
 * don't emit real stage transitions yet, so the widget runs a time-
 * driven progression to give the user the same visual rhythm during
 * an OC/Local turn that they get during a Codex turn. Stays on
 * `working` for the long tail of generation. */
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
