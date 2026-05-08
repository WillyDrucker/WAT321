import { homedir } from "node:os";
import { join } from "node:path";

/**
 * MJS counterpart to `src/shared/wat321Paths.ts`. Channel.mjs /
 * opencode.mjs / codex.mjs run as a separate process spawned by
 * Claude Code's MCP layer and cannot import TypeScript - this module
 * is the runtime path source of truth they share.
 *
 * The extension injects `WAT321_WORKSPACE_ID` into the MCP entry's
 * `--env` so this process sees the same wsId the extension uses for
 * file naming. Missing env (e.g. legacy registration that hasn't been
 * re-installed yet) falls back to "default".
 */

export const WAT321_ROOT = join(homedir(), ".wat321");
export const BRIDGE_BIN_DIR = join(WAT321_ROOT, "bridge", "bin");
export const CLIENTS_ROOT = join(WAT321_ROOT, "clients");

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

export function modelBridgeStateDir() {
  return join(clientStateDir(), "model-bridge");
}
