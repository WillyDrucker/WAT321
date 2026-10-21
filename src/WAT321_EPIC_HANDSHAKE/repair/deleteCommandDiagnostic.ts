import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { samePath } from "../../engine/fs/pathIdentity";
import { CODEX_SESSION_INDEX_PATH } from "../../shared/providers/codex/codexHome";
import { findRolloutPath, readRolloutCwd } from "../codexTurn/sessionRecovery";
import { ANY_WORKSPACE_THREAD_NAME } from "../codexTurn/threadNaming";

/**
 * Per-entry diagnostic for the Delete-All "(0) matched" case. When
 * the lister returns an empty set we want to explain WHY instead of
 * silently exiting - the index could be empty, or the entries could
 * all belong to a sibling workspace sharing this basename, or the
 * rollouts could be missing on disk. Each scanned bridge-pattern
 * entry produces one classification row that the caller writes to
 * the output channel - the short summary suits a toast. Returns null
 * when the index has no bridge-pattern entries at all (genuine
 * clean state - no diagnostic needed).
 */

interface DeleteAllDiagnostic {
  summary: string;
  rows: string[];
  basename: string;
}

export function buildDeleteAllDiagnostic(
  workspacePath: string
): DeleteAllDiagnostic | null {
  if (!existsSync(CODEX_SESSION_INDEX_PATH)) return null;

  const wsBasename = basename(workspacePath) || "Workspace";

  const rows: string[] = [];
  let matchingCount = 0;
  try {
    const raw = readFileSync(CODEX_SESSION_INDEX_PATH, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: { id?: string; thread_name?: string };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const name = entry.thread_name ?? "";
      if (!ANY_WORKSPACE_THREAD_NAME.test(name)) continue;
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
      const rolloutCwd = readRolloutCwd(rolloutPath);
      if (rolloutCwd === null) {
        rows.push(`${name} (${id.slice(0, 8)}...): rejected - cwd not readable from rollout`);
        continue;
      }
      if (!samePath(rolloutCwd, workspacePath)) {
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

  return { summary, rows, basename: wsBasename };
}
