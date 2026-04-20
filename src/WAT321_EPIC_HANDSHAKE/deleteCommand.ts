import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { EPIC_HANDSHAKE_DIR } from "./constants";
import { bridgeThreadDisplayName, type BridgeThreadRecord } from "./threadPersistence";
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
      const tmp = `${indexPath}.tmp`;
      writeFileSync(tmp, `${kept.join("\n")}\n`, "utf8");
      renameSync(tmp, indexPath);
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
  const tmp = `${recordPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  renameSync(tmp, recordPath);

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
