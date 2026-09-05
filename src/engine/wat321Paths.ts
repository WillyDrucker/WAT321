import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { workspaceHash } from "./workspaceHash";

/**
 * Per-client filesystem layout for WAT321 state.
 *
 * Two VS Code windows (or any two MCP clients) hitting the same
 * `~/.wat321/` would race on shared state files: bridge config,
 * OpenCode Routes config, session aliases, usage counters, harness
 * URL, channel log. This module is the single source of truth for
 * "where does this client's state live", keyed off
 * `WAT321_WORKSPACE_ID`.
 *
 * Layout:
 *
 *   ~/.wat321/
 *   ├── bridge/bin/                    (shared scripts)
 *   ├── epic-handshake/                (already partitioned via wsHash filename suffix)
 *   ├── claude-usage.cache.json        (read-only cache, shared)
 *   ├── codex-usage.cache.json         (read-only cache, shared)
 *   └── clients/<wsId>/
 *       ├── bridge/
 *       │   ├── config.json
 *       │   ├── session-aliases.json
 *       │   └── channel.log
 *       └── model-bridge/
 *           ├── config.json            (per-client harness URL + port)
 *           ├── last-used.json
 *           ├── usage.json
 *           ├── preferences.json
 *           ├── sessions/<alias>/
 *           └── opencode-workdir/opencode.json
 *
 * The wsId is the SHA-256 prefix of the workspace folder path (same
 * derivation Epic Handshake uses). When no workspace is open the id
 * falls back to "default" so a folderless VS Code window still gets
 * a stable client dir instead of crashing.
 */

/** Everything WAT321 writes outside `~/.claude/settings.json` lives
 * under this root: caches, claims, sentinels, per-client state. Reset
 * WAT321 clears it. */
export const WAT321_ROOT = join(homedir(), ".wat321");
export const CLIENTS_ROOT = join(WAT321_ROOT, "clients");

/** Active VS Code workspace hash, or "default" when no folder is
 * open. The extension sets `WAT321_WORKSPACE_ID` on `process.env` at
 * activate so spawned subprocesses (e.g. the OpenCode harness) inherit
 * it - the MCP installer injects the same value via `--env` so
 * channel.mjs sees it at boot. Computed fresh on every call so a
 * mid-session workspace change is picked up. */
export function workspaceId(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return "default";
  return workspaceHash(folder.uri.fsPath);
}

/** Per-client root: `~/.wat321/clients/<wsId>/`. */
export function clientStateDir(): string {
  return join(CLIENTS_ROOT, workspaceId());
}

export function bridgeStateDir(): string {
  return join(clientStateDir(), "bridge");
}

/** Per-client OpenCode Routes state dir. The on-disk literal stays
 * `model-bridge/` for upgrader compatibility - the helper name reflects
 * the LOGICAL purpose (OpenCode Routes tier state) rather than the
 * historical literal. Renaming the dir would look like lost sessions
 * and config to existing installs. */
export function openCodeRoutesStateDir(): string {
  return join(clientStateDir(), "model-bridge");
}
