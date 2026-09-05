import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * MJS counterpart to `src/engine/wat321Paths.ts`. The bridge runtime
 * runs as a separate process spawned by Claude Code's MCP layer and
 * cannot import TypeScript, so this module is the path source of
 * truth every runtime module shares.
 *
 * The extension injects `WAT321_WORKSPACE_ID` into the MCP entry's
 * `--env` so this process sees the same wsId the extension uses for
 * file naming. Missing env (a legacy registration that has not been
 * re-installed yet) falls back to "default".
 */

export const WAT321_ROOT = join(homedir(), ".wat321");
export const CLIENTS_ROOT = join(WAT321_ROOT, "clients");
/** Epic Handshake mailbox root shared by every workspace. Per-
 * workspace partitioning happens one level down. */
export const EPIC_HANDSHAKE_DIR = join(WAT321_ROOT, "epic-handshake");

export function workspaceId() {
  const id = process.env.WAT321_WORKSPACE_ID;
  if (typeof id === "string" && id.length > 0) return id;
  return "default";
}

export function clientStateDir() {
  return join(CLIENTS_ROOT, workspaceId());
}

export function bridgeStateDir() {
  return join(clientStateDir(), "bridge");
}

export function openCodeRoutesStateDir() {
  return join(clientStateDir(), "model-bridge");
}

export function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}
