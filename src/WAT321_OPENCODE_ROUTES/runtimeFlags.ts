import { existsSync } from "node:fs";
import { join } from "node:path";
import { clearFlag, setFlag } from "../engine/fs/flagFile";
import { OPENCODE_ROUTES_DIR } from "./openCodeRoutesPaths";

/**
 * Flag files the OpenCode Routes click menu writes under the per-client
 * routes state dir:
 *
 *   paused        - present while the menu shows Resume instead of
 *                   Pause. `isPaused` drives that row state.
 *   cancel.flag   - dropped by the Cancel row.
 *
 * The unified MCP runtime gates dispatch on the Epic Handshake paused
 * flag only and observes neither of these files, so they carry menu
 * state, not dispatch policy. Same `setFlag` / `clearFlag` shape as
 * the Epic Handshake toggles so both click menus read alike.
 */

const PAUSED_FLAG_PATH = join(OPENCODE_ROUTES_DIR, "paused");
const CANCEL_FLAG_PATH = join(OPENCODE_ROUTES_DIR, "cancel.flag");

export function isPaused(): boolean {
  return existsSync(PAUSED_FLAG_PATH);
}

export function setPaused(paused: boolean): void {
  if (paused) setFlag(PAUSED_FLAG_PATH);
  else clearFlag(PAUSED_FLAG_PATH);
}

export function writeCancelFlag(): void {
  setFlag(CANCEL_FLAG_PATH);
}
