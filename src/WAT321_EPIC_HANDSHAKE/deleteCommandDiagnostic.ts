import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readFirstLine } from "../shared/fs/fileReaders";
import { findRolloutPath } from "./threadPersistence";

/**
 * Per-entry diagnostic for the Delete-All "(0) matched" case. When
 * the lister returns an empty set we want to explain WHY instead of
 * silently exiting - the index could be empty, or the entries could
 * all belong to a sibling workspace sharing this basename, or the
 * rollouts could be missing on disk. Each scanned bridge-pattern
 * entry produces one classification row that the caller writes to
 * the output channel; the short summary suits a toast. Returns null
 * when the index has no bridge-pattern entries at all (genuine
 * clean state - no diagnostic needed).
 */

export interface DeleteAllDiagnostic {
  summary: string;
  rows: string[];
  basename: string;
  normalized: string;
}

export function buildDeleteAllDiagnostic(
  workspacePath: string
): DeleteAllDiagnostic | null {
  const indexPath = join(homedir(), ".codex", "session_index.jsonl");
  if (!existsSync(indexPath)) return null;

  const bridgeRe = /Epic Handshake Claude-to-Codex S(\d+)$/;
  const wsBasename = basename(workspacePath) || "Workspace";
  const wsNorm = normalizePath(workspacePath);

  const rows: string[] = [];
  let matchingCount = 0;
  try {
    const raw = readFileSync(indexPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: { id?: string; thread_name?: string };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const name = entry.thread_name ?? "";
      if (!bridgeRe.test(name)) continue;
      matchingCount++;
      const id = entry.id;
      if (typeof id !== "string") {
        rows.push(`${name}: rejected - no id in index entry`);
        continue;
      }
      if (!name.startsWith(`${wsBasename} `)) {
        rows.push(`${name}: rejected - basename mismatch (belongs to another workspace)`);
        continue;
      }
      const rolloutPath = findRolloutPath(id);
      if (rolloutPath === null) {
        rows.push(`${name} (${id.slice(0, 8)}...): rejected - rollout file missing on disk`);
        continue;
      }
      const rolloutCwd = readRolloutCwdHeader(rolloutPath);
      if (rolloutCwd === null) {
        rows.push(`${name} (${id.slice(0, 8)}...): rejected - cwd not readable from rollout`);
        continue;
      }
      if (normalizePath(rolloutCwd) !== wsNorm) {
        rows.push(`${name} (${id.slice(0, 8)}...): rejected - session_meta.cwd is "${rolloutCwd}" (expected "${workspacePath}")`);
        continue;
      }
      rows.push(`${name} (${id.slice(0, 8)}...): ACCEPTED - would be deleted`);
    }
  } catch {
    return null;
  }

  if (matchingCount === 0) return null;

  const summary = `no bridge sessions matched this workspace. Scanned ${matchingCount} bridge-pattern session${matchingCount === 1 ? "" : "s"} in the index. Click "View details" for the full breakdown.`;

  return { summary, rows, basename: wsBasename, normalized: wsNorm };
}

function normalizePath(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

function readRolloutCwdHeader(rolloutPath: string): string | null {
  const firstLine = readFirstLine(rolloutPath);
  if (firstLine === null) return null;
  try {
    const entry = JSON.parse(firstLine) as {
      type?: string;
      payload?: { cwd?: unknown };
    };
    if (entry.type !== "session_meta") return null;
    const cwd = entry.payload?.cwd;
    return typeof cwd === "string" ? cwd : null;
  } catch {
    return null;
  }
}
