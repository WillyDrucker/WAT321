import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { clearCheckboxSetting } from "./clearSettings";

/**
 * Healing for `wat321.*` settings that must never live at workspace
 * scope. Peeled out of `clearSettings.ts` so that file can stay
 * focused on the Reset WAT321 command orchestration and this file
 * can own the "find and strip stale workspace-scope keys" concern.
 *
 * Two-pronged heal:
 *
 *   1. User-scope cleanup via the normal config API (routed through
 *      `clearCheckboxSetting` imported back from clearSettings.ts).
 *      For an application-scoped setting VS Code accepts a Global
 *      write and silently ignores Workspace / WorkspaceFolder writes;
 *      either way this drops any lingering user-level value back to
 *      the schema default.
 *
 *   2. Direct file surgery on every open workspace folder's
 *      `.vscode/settings.json`. Necessary because VS Code refuses to
 *      modify application-scoped keys at workspace scope through the
 *      API, which would otherwise leave `"wat321.clearAllData":
 *      false` (or the experimental checkbox) physically present in
 *      the file forever. A stuck workspace value of either true or
 *      false breaks the change handler for these checkboxes
 *      (workspace overrides user during merge, so the handler's
 *      `config.get()` never sees the global transition).
 */

/** Keys that must never live at workspace scope because they are
 * action triggers (click to arm / click to reset) rather than
 * persistent preferences. Every key here is also declared as
 * `"scope": "application"` in package.json so that new writes cannot
 * land at workspace scope going forward; the heal below is for
 * early-adopter workspaces that still physically have the key in
 * their `.vscode/settings.json` from before the scope tightening. */
const APPLICATION_SCOPE_KEYS = [
  "wat321.clearAllData",
  "wat321.experimental.forceClaudeAutoCompact",
] as const;

/** Surgically strip a set of `wat321.*` keys from a single
 * settings.json file. Uses a conservative line-level regex per key
 * that matches the key at the start of its own line (optional
 * leading whitespace), any bool literal, and an optional trailing
 * comma. Preserves JSONC comments and every other key untouched
 * because we only delete the matching line. Atomic write via
 * tmp+rename so a crash mid-write cannot corrupt the file. Silent
 * no-op on missing file, IO error, or if no matching key is
 * present. */
function stripApplicationScopeKeysFromFile(path: string): void {
  if (!existsSync(path)) return;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }
  if (!APPLICATION_SCOPE_KEYS.some((k) => content.includes(k))) return;

  let next = content;
  for (const key of APPLICATION_SCOPE_KEYS) {
    // Escape any regex metachars in the key so `.` matches literally.
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Match the whole line, including its line terminator, so removing
    // it leaves surrounding formatting intact.
    const lineRegex = new RegExp(
      `^[ \\t]*"${escaped}"[ \\t]*:[ \\t]*(?:true|false)[ \\t]*,?[ \\t]*\\r?\\n`,
      "gm"
    );
    next = next.replace(lineRegex, "");
  }
  if (next === content) return;

  // Fix up a trailing comma that used to separate one of our keys
  // from the closing brace: `, \n}` -> `\n}`. Safe at the end of an
  // object literal. Runs after all strips so the final shape is
  // always valid JSONC.
  next = next.replace(/,(\s*})/g, "$1");

  try {
    const tmp = `${path}.wat321-heal.tmp`;
    writeFileSync(tmp, next, "utf8");
    // Atomic rename; on Windows this overwrites the target.
    renameSync(tmp, path);
  } catch {
    // best-effort
  }
}

/** Heal any stale application-scope key left behind by an older
 * WAT321 build (before these settings were tightened to
 * `scope: application`) or by a crashed prior run. Fire-and-forget
 * on activation. Never throws; every IO path is guarded. Scoped
 * narrowly to the keys in `APPLICATION_SCOPE_KEYS` - we never touch
 * any other setting in the file. */
export function healStaleApplicationScopeKeys(): void {
  void clearCheckboxSetting("clearAllData").catch(() => {
    // best-effort - never block activation
  });
  void clearCheckboxSetting("experimental.forceClaudeAutoCompact").catch(() => {
    // best-effort - never block activation
  });

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return;
  for (const folder of folders) {
    const settingsPath = join(folder.uri.fsPath, ".vscode", "settings.json");
    stripApplicationScopeKeysFromFile(settingsPath);
  }
}
