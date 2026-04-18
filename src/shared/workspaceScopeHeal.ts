import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";

/**
 * Heal stale workspace-scoped values for `wat321.*` settings whose
 * package.json declares `"scope": "application"`. VS Code's config
 * API refuses to modify application-scoped keys at workspace scope,
 * so a value already present in a workspace `.vscode/settings.json`
 * survives silently and can override the user's current preference.
 *
 * Two-pronged on activate:
 *   1. Strip from the workspace config API (for keys where the API
 *      still allows removal, e.g. action-trigger checkboxes).
 *   2. Surgically strip from every open workspace folder's
 *      `.vscode/settings.json` file (the durable fix).
 *
 * Known observed symptom: a user on `"System Notifications"` mode
 * seeing random "Auto"-style behavior because a stale workspace
 * override from an earlier default persists in their workspace
 * `.vscode/settings.json` even after the default changed upstream.
 */

/** Application-scoped `wat321.*` keys. Must stay in sync with the
 * `"scope": "application"` entries in package.json. */
const APPLICATION_SCOPE_KEYS = [
  `wat321.${SETTING.clearAllData}`,
  `wat321.${SETTING.notificationsMode}`,
  `wat321.${SETTING.notificationsClaude}`,
  `wat321.${SETTING.notificationsCodex}`,
] as const;

/** Value-pattern fragments matched per JSONC value shape. Ordered
 * so the longest / most-specific form wins. */
const VALUE_PATTERNS: readonly string[] = [
  `"[^"]*"`, // any double-quoted string
  `true|false`,
  `-?\\d+(?:\\.\\d+)?`,
];

/** Surgically strip a set of `wat321.*` keys from a settings.json
 * file. Matches each key at the start of its own line with any of
 * the value patterns above and an optional trailing comma. Preserves
 * JSONC comments and every other key untouched. Atomic tmp+rename so
 * a crash mid-write cannot corrupt the file. Silent on missing file
 * or IO error. */
function stripApplicationScopeKeysFromFile(path: string): void {
  if (!existsSync(path)) return;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }
  if (!APPLICATION_SCOPE_KEYS.some((k) => content.includes(k))) return;

  const valueUnion = VALUE_PATTERNS.join("|");
  let next = content;
  for (const key of APPLICATION_SCOPE_KEYS) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lineRegex = new RegExp(
      `^[ \\t]*"${escaped}"[ \\t]*:[ \\t]*(?:${valueUnion})[ \\t]*,?[ \\t]*\\r?\\n`,
      "gm"
    );
    next = next.replace(lineRegex, "");
  }
  if (next === content) return;

  // A trailing comma left after stripping the last entry before `}`
  // would make the object invalid JSON. Fix up: `, \n}` -> `\n}`.
  next = next.replace(/,(\s*})/g, "$1");

  try {
    const tmp = `${path}.wat321-heal.tmp`;
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, path);
  } catch {
    // best-effort
  }
}

/** Drop a stuck workspace-scope value via the config API where
 * possible. Best-effort; some scope/value combinations reject and
 * the file-surgery path is the durable fix. */
async function clearWorkspaceScope(key: string): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  try {
    await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
  } catch {
    // scope inapplicable or read-only - fine
  }
  try {
    await config.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  } catch {
    // scope inapplicable - fine
  }
}

/** Fire-and-forget heal on activation. Strips stale workspace-scope
 * values for every application-scoped wat321 key. Never throws. */
export function healStaleApplicationScopeKeys(): void {
  for (const key of APPLICATION_SCOPE_KEYS) {
    void clearWorkspaceScope(key).catch(() => {
      // best-effort - never block activation
    });
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return;
  for (const folder of folders) {
    const settingsPath = join(folder.uri.fsPath, ".vscode", "settings.json");
    stripApplicationScopeKeysFromFile(settingsPath);
  }
}
