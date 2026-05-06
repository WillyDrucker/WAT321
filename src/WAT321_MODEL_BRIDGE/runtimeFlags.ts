import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { MODEL_BRIDGE_DIR } from "./constants";

/**
 * Flag files the click menu writes for `channel.mjs` to observe:
 *
 *   paused        - present means refuse new tool calls. The drain
 *                   tools (`model_bridge_inbox`, `model_bridge_list`)
 *                   stay live so a paused user can still see what is
 *                   queued. Cleared by Resume.
 *
 *   cancel.flag   - present means the in-flight call should abort.
 *                   `channel.mjs` checks at handler entry and inside
 *                   the streaming loop. Self-clears once observed so
 *                   the next call is not cancelled spuriously.
 *
 * Mirrors the Epic Handshake `writeCancelFlag` / paused-toggle shape
 * so muscle memory carries over between the two click menus.
 */

const PAUSED_FLAG_PATH = join(MODEL_BRIDGE_DIR, "paused");
const CANCEL_FLAG_PATH = join(MODEL_BRIDGE_DIR, "cancel.flag");

export function isPaused(): boolean {
  return existsSync(PAUSED_FLAG_PATH);
}

export function setPaused(paused: boolean): void {
  if (paused) {
    writeFileAtomic(PAUSED_FLAG_PATH, new Date().toISOString());
  } else if (existsSync(PAUSED_FLAG_PATH)) {
    try {
      unlinkSync(PAUSED_FLAG_PATH);
    } catch {
      // best-effort
    }
  }
}

export function writeCancelFlag(): void {
  writeFileAtomic(CANCEL_FLAG_PATH, new Date().toISOString());
}
