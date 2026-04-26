import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import * as vscode from "vscode";
import { readFirstLine } from "../shared/fs/fileReaders";
import { EPIC_HANDSHAKE_DIR } from "./constants";
import {
  bridgeThreadDisplayName,
  findRolloutPath,
  listRecoverableSessions,
  type BridgeThreadRecord,
} from "./threadPersistence";
import type { EpicHandshakeLogger } from "./types";
import { workspaceHash } from "./workspaceHash";

/**
 * Destructive delete of the current workspace's Codex bridge session.
 * Full cleanup path:
 *
 *   1. Delete the rollout .jsonl under `~/.codex/sessions/YYYY/MM/DD/`
 *   2. Strip the matching entry from `~/.codex/session_index.jsonl`
 *      (atomic tmp+rename)
 *   3. Null out our `bridge-thread.<wshash>.json` (threadId=null,
 *      counter bump, failure fields reset)
 *
 * This reaches into Codex's own state files - philosophically we
 * avoid this in shipping code, but the explicit confirmation dialog
 * is the user's informed opt-in. Non-destructive alternative is the
 * soft Reset command.
 */

export async function deleteCurrentCodexSession(
  logger: EpicHandshakeLogger
): Promise<void> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspacePath === undefined) {
    void vscode.window.showWarningMessage(
      "Epic Handshake: no workspace folder open."
    );
    return;
  }

  const recordPath = join(
    EPIC_HANDSHAKE_DIR,
    `bridge-thread.${workspaceHash(workspacePath)}.json`
  );
  if (!existsSync(recordPath)) {
    void vscode.window.showInformationMessage(
      "Epic Handshake: no Codex session exists for this workspace."
    );
    return;
  }

  let record: BridgeThreadRecord;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8")) as BridgeThreadRecord;
  } catch {
    void vscode.window.showErrorMessage(
      "Epic Handshake: bridge-thread state is unreadable."
    );
    return;
  }

  if (record.threadId === null) {
    void vscode.window.showInformationMessage(
      "Epic Handshake: no active Codex session to delete (counter is already reset)."
    );
    return;
  }

  const sessionName = bridgeThreadDisplayName(workspacePath, record.sessionCounter);
  const confirmation = await vscode.window.showWarningMessage(
    `Permanently delete Codex session "${sessionName}"? This removes the rollout file and strips the entry from Codex's session index. The conversation history will be lost. Next Claude to Codex prompt spawns a fresh S${record.sessionCounter + 1}.`,
    "Delete",
    "Cancel"
  );
  if (confirmation !== "Delete") return;

  const threadId = record.threadId;
  let removedRollouts = 0;
  let strippedIndexLines = 0;

  // 1. Delete any rollout files matching the thread id
  const sessionsRoot = join(homedir(), ".codex", "sessions");
  try {
    for (const file of walk(sessionsRoot)) {
      if (file.includes(threadId)) {
        unlinkSync(file);
        removedRollouts++;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`rollout delete partial: ${msg}`);
  }

  // 2. Strip session_index.jsonl entry (atomic tmp+rename)
  const indexPath = join(homedir(), ".codex", "session_index.jsonl");
  if (existsSync(indexPath)) {
    try {
      const raw = readFileSync(indexPath, "utf8");
      const lines = raw.split("\n");
      const kept = lines.filter((line) => {
        if (!line.trim()) return false;
        try {
          const obj = JSON.parse(line) as { id?: string };
          return obj.id !== threadId;
        } catch {
          return true;
        }
      });
      strippedIndexLines = lines.filter((l) => l.trim()).length - kept.length;
      if (!writeFileAtomic(indexPath, `${kept.join("\n")}\n`)) {
        logger.warn("session_index strip failed: atomic write rejected");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`session_index strip failed: ${msg}`);
    }
  }

  // 3. Null our bridge-thread state
  const next: BridgeThreadRecord = {
    ...record,
    threadId: null,
    sessionCounter: record.sessionCounter + 1,
    lastResetAt: new Date().toISOString(),
    consecutiveFailures: 0,
    lastError: null,
    lastSuccessAt: null,
  };
  writeFileAtomic(recordPath, JSON.stringify(next, null, 2));

  logger.info(
    `codex session S${record.sessionCounter} deleted: ${removedRollouts} rollouts, ${strippedIndexLines} index entries. Next: S${next.sessionCounter}`
  );
  void vscode.window.showInformationMessage(
    `Epic Handshake: S${record.sessionCounter} deleted. Next Claude to Codex prompt spawns S${next.sessionCounter}.`
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Scan `~/.codex/session_index.jsonl` for bridge-pattern entries and
 * classify each against the current workspace. Used by Delete All to
 * explain a (0) result instead of silently exiting. Returns null when
 * the index has no bridge-pattern entries at all (genuine clean state);
 * otherwise returns the rows (one per scanned entry) plus a short
 * summary suitable for a toast. Detail goes to the Epic Handshake
 * output channel via the caller's logger. */
function buildDeleteAllDiagnostic(workspacePath: string): {
  summary: string;
  rows: string[];
  basename: string;
  normalized: string;
} | null {
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

/**
 * Destructive bulk delete of every Codex session matching this
 * workspace's bridge pattern. Enumerates sessions via
 * `listRecoverableSessions` (scans `~/.codex/session_index.jsonl`
 * for `^<basename> Epic Handshake Claude-to-Codex S\d+$` AND confirms
 * the rollout's `session_meta.cwd` equals the current workspacePath),
 * then for each one deletes the rollout file and strips the index
 * entry. Null's the local bridge-thread record at the end so the
 * next prompt spawns a fresh S<N+1>. Single confirmation covers the
 * whole set. The cwd-match gate in the lister is load-bearing:
 * without it a sibling workspace sharing this workspace's basename
 * would get swept by this delete.
 */
export async function deleteAllCodexSessions(
  logger: EpicHandshakeLogger
): Promise<void> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspacePath === undefined) {
    void vscode.window.showWarningMessage(
      "Epic Handshake: no workspace folder open."
    );
    return;
  }

  const sessions = listRecoverableSessions(workspacePath);
  if (sessions.length === 0) {
    // Diagnostic path: write the per-entry scan breakdown to the
    // Epic Handshake output channel and show a short toast pointing
    // at it. Keeps the on-screen feedback terse while preserving full
    // detail where a user can page through it.
    const diag = buildDeleteAllDiagnostic(workspacePath);
    if (diag === null) {
      void vscode.window.showInformationMessage(
        "Epic Handshake: no Codex bridge sessions found for this workspace."
      );
      return;
    }
    logger.info("[delete-all] (0) diagnostic:");
    for (const row of diag.rows) logger.info(`  ${row}`);
    logger.info(
      `[delete-all] workspace=${workspacePath} basename=${diag.basename} normalized=${diag.normalized}`
    );
    const pick = await vscode.window.showInformationMessage(
      `Epic Handshake: ${diag.summary}`,
      "View details"
    );
    if (pick === "View details") {
      logger.show();
    }
    return;
  }

  const confirmation = await vscode.window.showWarningMessage(
    `Permanently delete ALL ${sessions.length} Codex bridge session${sessions.length === 1 ? "" : "s"} for this workspace? This removes every rollout file and strips the matching entries from Codex's session index. All past bridge conversations will be lost.`,
    { modal: true, detail: sessions.map((s) => s.displayName).join("\n") },
    "Delete All",
    "Cancel"
  );
  if (confirmation !== "Delete All") return;

  const threadIds = new Set(sessions.map((s) => s.threadId));

  // 1. Delete every rollout file whose name contains any targeted
  // thread id. Single walk covers them all in one pass.
  const sessionsRoot = join(homedir(), ".codex", "sessions");
  let removedRollouts = 0;
  try {
    for (const file of walk(sessionsRoot)) {
      for (const tid of threadIds) {
        if (file.includes(tid)) {
          try {
            unlinkSync(file);
            removedRollouts++;
          } catch {
            // best-effort per file
          }
          break;
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`bulk rollout delete partial: ${msg}`);
  }

  // 2. One-shot session_index strip covering every targeted id.
  const indexPath = join(homedir(), ".codex", "session_index.jsonl");
  let strippedIndexLines = 0;
  if (existsSync(indexPath)) {
    try {
      const raw = readFileSync(indexPath, "utf8");
      const lines = raw.split("\n");
      const kept = lines.filter((line) => {
        if (!line.trim()) return false;
        try {
          const obj = JSON.parse(line) as { id?: string };
          return obj.id === undefined || !threadIds.has(obj.id);
        } catch {
          return true;
        }
      });
      strippedIndexLines = lines.filter((l) => l.trim()).length - kept.length;
      if (!writeFileAtomic(indexPath, `${kept.join("\n")}\n`)) {
        logger.warn("bulk session_index strip failed: atomic write rejected");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`bulk session_index strip failed: ${msg}`);
    }
  }

  // 3. Null our bridge-thread state, bump counter past the highest
  // session number we just deleted so the next prompt spawns with
  // a clean S<N+1> that cannot collide with any leftover.
  const recordPath = join(
    EPIC_HANDSHAKE_DIR,
    `bridge-thread.${workspaceHash(workspacePath)}.json`
  );
  const maxSeen = sessions.reduce((m, s) => Math.max(m, s.sessionCounter), 0);
  if (existsSync(recordPath)) {
    try {
      const raw = readFileSync(recordPath, "utf8");
      const record = JSON.parse(raw) as BridgeThreadRecord;
      const next: BridgeThreadRecord = {
        ...record,
        threadId: null,
        sessionCounter: Math.max(record.sessionCounter, maxSeen) + 1,
        lastResetAt: new Date().toISOString(),
        consecutiveFailures: 0,
        lastError: null,
        lastSuccessAt: null,
      };
      if (!writeFileAtomic(recordPath, JSON.stringify(next, null, 2))) {
        logger.warn("bridge-thread record null failed: atomic write rejected");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`bridge-thread record null failed: ${msg}`);
    }
  }

  logger.info(
    `bulk codex session delete: ${sessions.length} threads targeted, ${removedRollouts} rollouts removed, ${strippedIndexLines} index entries stripped`
  );
  void vscode.window.showInformationMessage(
    `Epic Handshake: deleted ${sessions.length} Codex session${sessions.length === 1 ? "" : "s"}. Next Claude to Codex prompt spawns a fresh session.`
  );
}
