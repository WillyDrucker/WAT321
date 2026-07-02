import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { writeFileAtomic } from "./fs/atomicWrite";

/**
 * One-time removal of the pre-1.6.0 Epic Handshake bridge for users
 * upgrading from a bridge-era WAT321. v1.6.0 spun the bridge out into
 * the standalone EH321 product, so what the old build wrote is now
 * orphaned: an MCP registration Claude Code keeps trying to spawn
 * against a deleted runtime, an allowlist the user never granted by
 * hand, and a dead bin + state tree on disk. This sweeps all of it so
 * a fresh 1.6.0 lands clean and a fresh install (no prior bridge) is a
 * no-op.
 *
 * SCOPE CONTRACT - targets ONLY the legacy WAT321 bridge:
 *   - the MCP server named `wat321` (each workspace's `.mcp.json`, plus
 *     dormant `~/.claude.json` user-scope and project entries)
 *   - `permissions.allow` entries prefixed `mcp__wat321__` in
 *     `~/.claude/settings.json`
 *   - bridge runtime + state under `~/.wat321/`: top-level `bridge/`,
 *     `epic-handshake/`, `model-bridge/`, and the `bridge` +
 *     `model-bridge` subdir of each `clients/<id>/`
 *
 * EH321-SAFE BY CONSTRUCTION. The new bridge registers under its OWN
 * name (`eh321`) and its OWN per-OS data dir (`%APPDATA%/epic-handshake`
 * on Windows, NOT `~/.wat321/`), so no target here can match it. Mind
 * the trap: `~/.wat321/epic-handshake/` (legacy state, swept) is a
 * DIFFERENT path from EH321's `%APPDATA%/epic-handshake` (never
 * touched). Never broaden a target to a bare `epic-handshake` name or
 * a looser `mcp__` prefix that could catch the new bridge.
 *
 * PRESERVES WAT321's own `~/.wat321/` state: the usage caches and each
 * client's `*-transitions.jsonl`, `fired-notifications/`,
 * `notification-events.jsonl`, and `usage-snapshot.json`.
 *
 * Best-effort and idempotent: a locked file never blocks activation. The
 * user-wide surfaces are gated by globalState, but the guard is set ONLY
 * when every target was already absent or cleaned successfully - a failed
 * write (a Claude config locked by a concurrent writer, say) leaves the
 * guard unset so the next activation retries. Each open workspace's
 * `.mcp.json` is swept on every activation regardless, so a workspace
 * first opened after the guard was set still self-heals (its dead entry
 * would otherwise have Claude Code spawn a deleted runtime).
 */

const LEGACY_MCP_NAME = "wat321";
const ALLOWLIST_PREFIX = "mcp__wat321__";
const BRIDGE_STATE_DIRS = ["bridge", "epic-handshake", "model-bridge"] as const;
const PER_CLIENT_BRIDGE_SUBDIRS = ["bridge", "model-bridge"] as const;
const WAT321_DIR = join(homedir(), ".wat321");
const CLAUDE_JSON = join(homedir(), ".claude.json");
const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
// Bumped to .v2 with the guard fix: the prior logic could set the key
// after a failed cleanup, so a new key forces those installs to retry
// (the sweep is idempotent, so a needless retry is a no-op).
const HEAL_DONE_KEY = "wat321.legacyBridgeRemoved.v2";

/** Remove the legacy bridge. Call once from `activate`. */
export function removeLegacyBridge(context: vscode.ExtensionContext): void {
  // Per-workspace, every activation: sweep the open workspace's
  // `.mcp.json`. The global guard below would otherwise miss any
  // workspace first opened after the heal already ran once.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    sweepWorkspaceMcpJson(folder.uri.fsPath);
  }

  // User-wide surfaces: run until they fully succeed. Set the guard only
  // when every target was already absent or cleaned, so a locked config
  // retries on a later activation instead of being recorded as done.
  if (context.globalState.get<boolean>(HEAL_DONE_KEY) === true) return;
  const allowlistOk = removeAllowlistEntries();
  const claudeJsonOk = sweepClaudeJsonEntries();
  const stateOk = removeBridgeState();
  if (allowlistOk && claudeJsonOk && stateOk) {
    void context.globalState
      .update(HEAL_DONE_KEY, true)
      .then(undefined, () => {
        // best-effort: a failed guard write just retries next activation
      });
  }
}

/** Delete the `wat321` server from one workspace's `.mcp.json`. If that
 * empties an otherwise bridge-only file, remove the file so the
 * workspace returns to its pre-bridge state. A file holding other
 * servers or keys is preserved, minus the `wat321` entry. */
function sweepWorkspaceMcpJson(workspacePath: string): void {
  const path = join(workspacePath, ".mcp.json");
  const parsed = readJsonObject(path);
  if (parsed === null) return;
  const servers = parsed.mcpServers;
  if (typeof servers !== "object" || servers === null) return;
  const map = servers as Record<string, unknown>;
  if (!(LEGACY_MCP_NAME in map)) return;
  delete map[LEGACY_MCP_NAME];
  const bridgeOnlyFile =
    Object.keys(map).length === 0 && Object.keys(parsed).length === 1;
  try {
    if (bridgeOnlyFile) {
      rmSync(path, { force: true });
    } else {
      writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`);
    }
  } catch {
    // best-effort
  }
}

/** Strip every `mcp__wat321__*` entry from `permissions.allow` in
 * `~/.claude/settings.json`, leaving the rest of the file untouched.
 * Returns false only when a needed write failed (nothing-to-do is true). */
function removeAllowlistEntries(): boolean {
  const parsed = readJsonObject(CLAUDE_SETTINGS);
  if (parsed === null) return true;
  const permissions = parsed.permissions;
  if (typeof permissions !== "object" || permissions === null) return true;
  const holder = permissions as { allow?: unknown };
  if (!Array.isArray(holder.allow)) return true;
  const before = holder.allow.length;
  // Keep everything that is NOT a `mcp__wat321__*` string - including any
  // non-string entries, which we never own and must not silently drop.
  const filtered = holder.allow.filter(
    (t) => typeof t !== "string" || !t.startsWith(ALLOWLIST_PREFIX)
  );
  if (filtered.length === before) return true;
  holder.allow = filtered;
  return writeFileAtomic(CLAUDE_SETTINGS, `${JSON.stringify(parsed, null, 2)}\n`);
}

/** Remove `wat321` MCP entries from `~/.claude.json` - the top-level
 * `mcpServers` (user scope) and any dormant `projects.*.mcpServers`
 * (an older registration mechanism). Writes only when something was
 * actually removed, so a config with none is read but never rewritten.
 * Returns false only when that rewrite failed. */
function sweepClaudeJsonEntries(): boolean {
  const parsed = readJsonObject(CLAUDE_JSON);
  if (parsed === null) return true;
  let changed = deleteServerEntry(parsed.mcpServers);
  const projects = parsed.projects;
  if (typeof projects === "object" && projects !== null) {
    for (const project of Object.values(projects as Record<string, unknown>)) {
      if (typeof project !== "object" || project === null) continue;
      if (deleteServerEntry((project as { mcpServers?: unknown }).mcpServers)) {
        changed = true;
      }
    }
  }
  if (!changed) return true;
  return writeFileAtomic(CLAUDE_JSON, `${JSON.stringify(parsed, null, 2)}\n`);
}

/** Delete the `wat321` key from an `mcpServers` map if present.
 * Returns whether anything changed. */
function deleteServerEntry(servers: unknown): boolean {
  if (typeof servers !== "object" || servers === null) return false;
  const map = servers as Record<string, unknown>;
  if (!(LEGACY_MCP_NAME in map)) return false;
  delete map[LEGACY_MCP_NAME];
  return true;
}

/** Delete the bridge runtime and state from `~/.wat321/`: the
 * top-level bridge dirs and the bridge subdirs of each client. WAT321's
 * own per-client state (usage transitions, fired-notifications,
 * notification events, usage snapshot) is left in place. Returns false
 * only when a removal failed - a missing path counts as success. */
function removeBridgeState(): boolean {
  let ok = true;
  for (const dir of BRIDGE_STATE_DIRS) {
    if (!safeRmDir(join(WAT321_DIR, dir))) ok = false;
  }
  const clientsRoot = join(WAT321_DIR, "clients");
  let clientIds: string[];
  try {
    clientIds = readdirSync(clientsRoot);
  } catch {
    return ok;
  }
  for (const id of clientIds) {
    const clientDir = join(clientsRoot, id);
    // Skip a symlinked client dir: a planted link could redirect the
    // recursive delete outside ~/.wat321. Real client dirs are plain.
    try {
      if (lstatSync(clientDir).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    for (const sub of PER_CLIENT_BRIDGE_SUBDIRS) {
      if (!safeRmDir(join(clientDir, sub))) ok = false;
    }
  }
  return ok;
}

function safeRmDir(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Read + parse a JSON file as an object. Returns null when the file is
 * absent, unreadable, unparseable, or not a JSON object. */
function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  return parsed as Record<string, unknown>;
}
