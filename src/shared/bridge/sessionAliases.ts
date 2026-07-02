import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../fs/atomicWrite";

/**
 * Session alias storage shared by the unified bridge MCP server, the
 * Epic Handshake session pickers, and the status-bar widget. The file
 * lives at `~/.wat321/clients/<wsId>/bridge/session-aliases.json` and
 * carries:
 *   - per-target alias bucket (`opencode`, `local`) mapping S1, S2, ...
 *     to `{sessionId, instanceId}`
 *   - `activeAliases` per target - the alias the bridge consumer
 *     resolves to when a wat321_ask call omits `session`. The EH menu's
 *     CURRENT row writes this - bin/opencode.mjs reads it.
 *
 * `instanceId` on each entry is the catalog id the session was bound to
 * at create time. Persisting it lets the heartbeat layer render the
 * actually-bound model on resume rather than the user's currently-
 * active model, which can drift when they switch the MODEL row between
 * sessions. OpenCode's session storage pins the model server-side, so
 * the alias-side instanceId mirrors that truth.
 *
 * Legacy normalization: pre-instanceId alias entries stored a bare
 * session-id string. `readAliases` normalizes those to
 * `{sessionId, instanceId: null}` on read so existing users don't lose
 * sessions on upgrade. `activeAliases` is normalized to `null` when
 * absent or pointing at an alias the bucket no longer contains.
 */

export type SessionTarget = "opencode" | "local";

export interface AliasEntry {
  sessionId: string;
  /** Catalog id the session was bound to at create time. Null for
   * legacy alias entries written before the instanceId was tracked. */
  instanceId: string | null;
}

export interface AliasMap {
  opencode: Record<string, AliasEntry>;
  local: Record<string, AliasEntry>;
  /** Per-target active alias. `null` means "no active session" - the
   * EH menu's CURRENT row falls back to "Created on next prompt..." and
   * the next bridge dispatch creates + marks-active a fresh session.
   * Stored in the same file so menu + bridge share a single source. */
  activeAliases: { opencode: string | null; local: string | null };
}

function normalizeBucket(raw: unknown): Record<string, AliasEntry> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, AliasEntry> = {};
  for (const [alias, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      out[alias] = { sessionId: value, instanceId: null };
      continue;
    }
    if (value && typeof value === "object") {
      const v = value as { sessionId?: unknown; instanceId?: unknown };
      if (typeof v.sessionId === "string") {
        out[alias] = {
          sessionId: v.sessionId,
          instanceId:
            typeof v.instanceId === "string" && v.instanceId.length > 0
              ? v.instanceId
              : null,
        };
      }
    }
  }
  return out;
}

function emptyMap(): AliasMap {
  return {
    opencode: {},
    local: {},
    activeAliases: { opencode: null, local: null },
  };
}

function normalizeActive(
  raw: unknown,
  bucket: Record<string, AliasEntry>
): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw in bucket ? raw : null;
}

export function readAliases(path: string): AliasMap {
  if (!existsSync(path)) return emptyMap();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      opencode?: unknown;
      local?: unknown;
      activeAliases?: { opencode?: unknown; local?: unknown };
    };
    const opencode = normalizeBucket(parsed.opencode);
    const local = normalizeBucket(parsed.local);
    return {
      opencode,
      local,
      activeAliases: {
        opencode: normalizeActive(parsed.activeAliases?.opencode, opencode),
        local: normalizeActive(parsed.activeAliases?.local, local),
      },
    };
  } catch {
    return emptyMap();
  }
}

export function writeAliases(path: string, map: AliasMap): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileAtomic(path, JSON.stringify(map, null, 2));
}

