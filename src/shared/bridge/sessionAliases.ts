import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../fs/atomicWrite";

/**
 * Session alias storage shared by the unified bridge MCP server, the
 * Epic Handshake session pickers, and the status-bar widget. The file
 * lives at `~/.wat321/bridge/session-aliases.json` and maps per-target
 * aliases (S1, S2, ...) to a `{sessionId, instanceId}` pair.
 *
 * The `instanceId` is the catalog id the session was bound to at
 * create time. Persisting it lets the heartbeat layer render the
 * actually-bound model on resume rather than the user's currently-
 * active model, which can drift when they switch the MODEL row
 * between sessions. OpenCode's session storage pins the model
 * server-side, so the alias-side instanceId mirrors that truth.
 *
 * Legacy normalization: pre-v1.4.4 alias files stored bare session-id
 * strings instead of `{sessionId, instanceId}` objects. `readAliases`
 * normalizes string-form entries to `{sessionId, instanceId: null}`
 * on read so existing users don't lose sessions on upgrade. Null
 * instanceId means "unknown" - callers fall back to the active
 * instance for those entries until the alias is recreated.
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

export function readAliases(path: string): AliasMap {
  if (!existsSync(path)) return { opencode: {}, local: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      opencode?: unknown;
      local?: unknown;
    };
    return {
      opencode: normalizeBucket(parsed.opencode),
      local: normalizeBucket(parsed.local),
    };
  } catch {
    return { opencode: {}, local: {} };
  }
}

export function writeAliases(path: string, map: AliasMap): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileAtomic(path, JSON.stringify(map, null, 2));
}

/** Pick the next free `S<n>` alias for a target bucket. */
export function nextAlias(bucket: Record<string, AliasEntry>): string {
  const taken = Object.keys(bucket);
  let n = 1;
  while (taken.includes(`S${n}`)) n++;
  return `S${n}`;
}
