import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { workspaceHash } from "./workspaceHash";

/**
 * Per-client filesystem layout for WAT321 state under `~/.wat321/`.
 *
 * Two VS Code windows on the same workspace would otherwise race on
 * shared state. This module is the single source of truth for "where
 * does this client's state live", keyed off the workspace hash.
 *
 * Layout:
 *
 *   ~/.wat321/
 *   ├── claude-usage.cache.json                (read-only cache, shared)
 *   ├── codex-usage.cache.json                 (read-only cache, shared)
 *   └── clients/<wsId>/
 *       └── <provider>-usage-transitions.jsonl (usage transition logs)
 *
 * The wsId is the SHA-256 prefix of the workspace folder path. When no
 * workspace is open the id falls back to "default" so a folderless VS
 * Code window still gets a stable client dir instead of crashing.
 */

export const WAT321_ROOT = join(homedir(), ".wat321");
export const CLIENTS_ROOT = join(WAT321_ROOT, "clients");

/** Active VS Code workspace hash, or "default" when no folder is
 * open. Computed fresh on every call so a mid-session workspace
 * change is picked up. */
export function workspaceId(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return "default";
  return workspaceHash(folder.uri.fsPath);
}

/** Per-client root: `~/.wat321/clients/<wsId>/`. */
export function clientStateDir(): string {
  return join(CLIENTS_ROOT, workspaceId());
}
