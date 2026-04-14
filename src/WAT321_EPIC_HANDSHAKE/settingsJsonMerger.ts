import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read / parse / merge / uninstall helpers for
 * `~/.claude/settings.json`. The only cross-tool write Epic Handshake
 * performs is exactly one entry under `hooks.UserPromptSubmit`,
 * identified by a distinctive command-path signature so uninstall is
 * surgical and never touches other entries.
 *
 * Claude Code's settings.json can contain JSONC comments. Rather than
 * pull in a JSONC parser dependency (violating zero-runtime-deps) or
 * hand-roll comment stripping (brittle), we detect comments during
 * read and refuse to auto-merge. Callers surface the exact entry the
 * user can paste manually and Epic Handshake degrades to click-to-
 * paste via the status bar widget.
 */

/** Path to the user's Claude Code global settings file. */
export const CLAUDE_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

/** Distinctive substring used to identify OUR hook entry inside
 * `settings.json`. Any hook whose `command` string contains this
 * substring is treated as WAT321-owned and eligible for uninstall.
 * Never matches a user's own hooks or other extensions' hooks. */
const WAT321_COMMAND_SIGNATURE = ".wat321/epic-handshake/hooks/deliverInbox";

/** Alternative Windows-style signature (backslash path). Used in
 * parallel with the forward-slash form because the command string is
 * stored verbatim as the extension wrote it, and Windows paths use
 * backslashes. */
const WAT321_COMMAND_SIGNATURE_WIN = ".wat321\\epic-handshake\\hooks\\deliverInbox";

/** Read outcome discriminated union. Callers must handle every case:
 *
 * - `missing`: the file does not exist. Merging is safe - we create
 *    the file with just our entry.
 * - `present`: the file exists, is parseable, and contains a plain
 *    object. Merging is safe.
 * - `jsonc-comments`: the file exists but contains JSONC-style
 *    comments. Merging is refused. Caller surfaces the exact entry
 *    for manual paste.
 * - `io-error`: the file exists but could not be read. Merging is
 *    refused. Caller surfaces a passive status.
 * - `parse-error`: the file exists and was read successfully but is
 *    not valid JSON. Merging is refused. Caller surfaces a passive
 *    status. */
export type ReadSettingsResult =
  | { kind: "present"; data: Record<string, unknown> }
  | { kind: "missing" }
  | { kind: "jsonc-comments" }
  | { kind: "io-error" }
  | { kind: "parse-error" };

/** Shape of our hook entry as it appears inside the
 * `hooks.UserPromptSubmit` array. We write this exact shape; we
 * recognize it on uninstall via the command-path signature. */
export interface WatHookEntry {
  matcher: string;
  hooks: {
    type: "command";
    command: string;
    timeout: number;
  }[];
}

/** Read `~/.claude/settings.json` and return a discriminated result.
 * Detects JSONC comments via a conservative regex scan before
 * attempting JSON.parse, because `JSON.parse` rejects comments with a
 * generic error that is indistinguishable from other parse failures. */
export function readClaudeSettings(
  path: string = CLAUDE_SETTINGS_PATH
): ReadSettingsResult {
  if (!existsSync(path)) return { kind: "missing" };

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { kind: "io-error" };
  }

  if (containsJsoncComments(text)) return { kind: "jsonc-comments" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "parse-error" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "parse-error" };
  }

  return { kind: "present", data: parsed as Record<string, unknown> };
}

/** Write the given settings object to `~/.claude/settings.json`
 * atomically via tmp+rename. Returns true on success. Never throws. */
export function writeClaudeSettings(
  data: Record<string, unknown>,
  path: string = CLAUDE_SETTINGS_PATH
): boolean {
  try {
    const text = `${JSON.stringify(data, null, 2)}\n`;
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, text, "utf8");
    renameSync(tmpPath, path);
    return true;
  } catch {
    return false;
  }
}

/** Construct the hook entry WAT321 writes. `scriptPath` is the
 * absolute path to the installed hook script under
 * `~/.wat321/epic-handshake/hooks/deliverInbox.js`. The command uses
 * `node "<scriptPath>"` so Windows path separators are quoted
 * correctly. */
export function buildHookEntry(scriptPath: string): WatHookEntry {
  return {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: `node "${scriptPath}"`,
        timeout: 30,
      },
    ],
  };
}

/** Add our hook entry to the settings object in place. Idempotent:
 * if an entry matching our signature already exists, it is replaced
 * in place rather than duplicated. Other hook entries are never
 * touched. Returns `true` if the data was changed, `false` if it
 * already matched. */
export function addHookEntry(
  data: Record<string, unknown>,
  scriptPath: string
): boolean {
  const hooks = getOrCreateObject(data, "hooks");
  const userPromptSubmit = getOrCreateArray(hooks, "UserPromptSubmit");

  const newEntry = buildHookEntry(scriptPath);
  const newCommand = newEntry.hooks[0].command;

  for (let i = 0; i < userPromptSubmit.length; i++) {
    const existing = userPromptSubmit[i];
    if (isWatHookEntry(existing)) {
      const existingHooks = (existing as Record<string, unknown>).hooks;
      let existingCommand = "";
      if (Array.isArray(existingHooks) && existingHooks.length > 0) {
        const firstHook = existingHooks[0] as Record<string, unknown>;
        const cmd = firstHook.command;
        if (typeof cmd === "string") existingCommand = cmd;
      }
      if (existingCommand === newCommand) return false;
      // Stale entry: replace it in place
      userPromptSubmit[i] = newEntry as unknown as Record<string, unknown>;
      return true;
    }
  }

  userPromptSubmit.push(newEntry as unknown as Record<string, unknown>);
  return true;
}

/** Remove any WAT321-owned hook entry from the settings object in
 * place. Matches entries whose `command` field contains our
 * distinctive signature. Returns the number of entries removed. */
export function removeHookEntry(data: Record<string, unknown>): number {
  const hooks = data.hooks;
  if (typeof hooks !== "object" || hooks === null) return 0;
  const ups = (hooks as Record<string, unknown>).UserPromptSubmit;
  if (!Array.isArray(ups)) return 0;

  let removed = 0;
  for (let i = ups.length - 1; i >= 0; i--) {
    if (isWatHookEntry(ups[i])) {
      ups.splice(i, 1);
      removed++;
    }
  }

  // Best-effort cleanup: if UserPromptSubmit is now empty, remove it.
  // If hooks is now empty, remove it too. Keeps the user's settings
  // file tidy.
  if (ups.length === 0) {
    delete (hooks as Record<string, unknown>).UserPromptSubmit;
  }
  if (Object.keys(hooks as Record<string, unknown>).length === 0) {
    delete data.hooks;
  }

  return removed;
}

/** Check whether our hook entry is currently present in the settings
 * object. Used by `hookInstaller.verify` for idempotency. */
export function hasHookEntry(data: Record<string, unknown>): boolean {
  const hooks = data.hooks;
  if (typeof hooks !== "object" || hooks === null) return false;
  const ups = (hooks as Record<string, unknown>).UserPromptSubmit;
  if (!Array.isArray(ups)) return false;
  return ups.some((entry) => isWatHookEntry(entry));
}

/** Build the manual-paste instruction string for the JSONC fallback
 * case. Returned to the caller so it can be shown to the user as a
 * copy-paste snippet. */
export function buildManualInstallSnippet(scriptPath: string): string {
  const entry = buildHookEntry(scriptPath);
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [entry],
      },
    },
    null,
    2
  );
}

/** Identify a hook entry as WAT321-owned by checking whether any of
 * its `hooks[].command` strings contain our distinctive path
 * signature (in either forward-slash or backslash form). */
function isWatHookEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const hooks = (entry as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) return false;
  for (const h of hooks) {
    if (typeof h !== "object" || h === null) continue;
    const command = (h as Record<string, unknown>).command;
    if (typeof command !== "string") continue;
    if (
      command.includes(WAT321_COMMAND_SIGNATURE) ||
      command.includes(WAT321_COMMAND_SIGNATURE_WIN)
    ) {
      return true;
    }
  }
  return false;
}

/** Ensure `data[key]` is an object and return it. Creates an empty
 * object if the key is missing or holds a non-object. Preserves
 * existing content. */
function getOrCreateObject(
  data: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const existing = data[key];
  if (
    typeof existing === "object" &&
    existing !== null &&
    !Array.isArray(existing)
  ) {
    return existing as Record<string, unknown>;
  }
  const fresh: Record<string, unknown> = {};
  data[key] = fresh;
  return fresh;
}

/** Ensure `data[key]` is an array and return it. Creates an empty
 * array if the key is missing or holds a non-array. */
function getOrCreateArray(
  data: Record<string, unknown>,
  key: string
): Record<string, unknown>[] {
  const existing = data[key];
  if (Array.isArray(existing)) {
    return existing as Record<string, unknown>[];
  }
  const fresh: Record<string, unknown>[] = [];
  data[key] = fresh;
  return fresh;
}

/** Conservative JSONC comment detector. Returns true if the text
 * appears to contain line comments (`//`) or block comments (`/* *\/`)
 * outside of string literals. False positives are acceptable - we
 * would rather refuse a clean JSON file that happens to contain the
 * substring "//" in a string value than silently corrupt a JSONC
 * file. The scanner walks the text character-by-character tracking
 * whether we are inside a double-quoted string. */
export function containsJsoncComments(text: string): boolean {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "/" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "/" || next === "*") return true;
    }
  }
  return false;
}
