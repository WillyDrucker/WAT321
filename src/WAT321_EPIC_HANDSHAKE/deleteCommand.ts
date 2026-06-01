import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { EPIC_HANDSHAKE_DIR } from "./constants";
import { buildDeleteAllDiagnostic } from "./deleteCommandDiagnostic";
import {
  clearBridgeThreadRecord,
  deleteRolloutFilesByThreadId,
  stripSessionIndexEntries,
} from "./deleteCommandSteps";
import {
  bridgeThreadDisplayName,
  listRecoverableSessions,
  type BridgeThreadRecord,
} from "./threadPersistence";
import { bridgeThreadNamePattern } from "./threadNaming";
import type { EpicHandshakeLogger } from "./types";
import { workspaceHash } from "../shared/workspaceHash";

/**
 * Destructive delete of the current workspace's Codex bridge session
 * (single, or every session under this workspace's bridge pattern).
 * Full cleanup path:
 *
 *   1. Delete rollout .jsonl files under `~/.codex/sessions/YYYY/MM/DD/`
 *   2. Strip matching entries from `~/.codex/session_index.jsonl`
 *      (bulk path also runs an orphan sweep for rollouts deleted out-
 *      of-band)
 *   3. Null our `bridge-thread.<wshash>.json` (threadId=null, counter
 *      bumped via `nextCollisionFreeCounter`, failure fields reset)
 *
 * We reach into Codex's own state files here - philosophically we
 * avoid this in shipping code, but the explicit confirmation dialog
 * is the user's informed opt-in. The non-destructive alternative is
 * the soft Reset command. Step mechanics live in `deleteCommandSteps`;
 * the empty-result diagnostic lives in `deleteCommandDiagnostic`.
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
    `Delete Codex session "${sessionName}"? Removes the rollout file and strips the entry from Codex's session index. The next Claude-to-Codex prompt spawns a fresh session at the lowest free S<n>.`,
    "Delete",
    "Cancel"
  );
  if (confirmation !== "Delete") return;

  const threadIds = new Set([record.threadId]);
  const removedRollouts = deleteRolloutFilesByThreadId(
    threadIds,
    logger,
    "rollout delete partial"
  );
  const strippedIndexLines = stripSessionIndexEntries(
    threadIds,
    null,
    logger,
    "session_index strip failed"
  );
  const projectedNext = clearBridgeThreadRecord(
    workspacePath,
    recordPath,
    record,
    logger,
    "bridge-thread record null failed"
  );

  logger.info(
    `codex session S${record.sessionCounter} deleted: ${removedRollouts} rollouts, ${strippedIndexLines} index entries. Next: S${projectedNext ?? "?"}`
  );
  void vscode.window.showInformationMessage(
    `Epic Handshake: S${record.sessionCounter} deleted. Next Claude to Codex prompt spawns ${projectedNext !== null ? `S${projectedNext}` : "a fresh session"}.`
  );
}

/**
 * Destructive bulk delete of every Codex session matching this
 * workspace's bridge pattern. Enumerates via `listRecoverableSessions`
 * (scans `~/.codex/session_index.jsonl` for the workspace-prefixed
 * bridge pattern AND confirms the rollout's `session_meta.cwd` matches),
 * then for each one deletes the rollout file and strips the index
 * entry. The cwd-match gate in the lister is load-bearing: without
 * it a sibling workspace sharing this workspace's basename would get
 * swept. The index strip in this path also runs an orphan sweep -
 * drops entries whose rollout file is gone - so the gap-fill counter
 * can collapse back to S1 instead of getting blocked by deleted-out-
 * of-band orphans.
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
    const diag = buildDeleteAllDiagnostic(workspacePath);
    if (diag === null) {
      void vscode.window.showInformationMessage(
        "Epic Handshake: no Codex bridge sessions found for this workspace."
      );
      return;
    }
    // Per-entry breakdown goes to the output channel; toast stays short
    // and points the user there.
    logger.info("[delete-all] (0) diagnostic:");
    for (const row of diag.rows) logger.info(`  ${row}`);
    logger.info(
      `[delete-all] workspace=${workspacePath} basename=${diag.basename} normalized=${diag.normalized}`
    );
    const pick = await vscode.window.showInformationMessage(
      `Epic Handshake: ${diag.summary}`,
      "View details"
    );
    if (pick === "View details") logger.show();
    return;
  }

  const confirmation = await vscode.window.showWarningMessage(
    `Delete ALL ${sessions.length} Codex bridge session${sessions.length === 1 ? "" : "s"} for this workspace? Sessions: ${sessions.map((s) => s.displayName).join(", ")}.`,
    "Delete All",
    "Cancel"
  );
  if (confirmation !== "Delete All") return;

  const threadIds = new Set(sessions.map((s) => s.threadId));
  const removedRollouts = deleteRolloutFilesByThreadId(
    threadIds,
    logger,
    "bulk rollout delete partial"
  );
  const strippedIndexLines = stripSessionIndexEntries(
    threadIds,
    bridgeThreadNamePattern(workspacePath),
    logger,
    "bulk session_index strip failed"
  );
  const recordPath = join(
    EPIC_HANDSHAKE_DIR,
    `bridge-thread.${workspaceHash(workspacePath)}.json`
  );
  const projectedNext = clearBridgeThreadRecord(
    workspacePath,
    recordPath,
    null,
    logger,
    "bridge-thread record null failed"
  );

  logger.info(
    `bulk codex session delete: ${sessions.length} threads targeted, ${removedRollouts} rollouts removed, ${strippedIndexLines} index entries stripped${projectedNext !== null ? `, next=S${projectedNext}` : ""}`
  );
  void vscode.window.showInformationMessage(
    `Epic Handshake: deleted ${sessions.length} Codex session${sessions.length === 1 ? "" : "s"}. Next Claude to Codex prompt spawns ${projectedNext !== null ? `S${projectedNext}` : "a fresh session"}.`
  );
}
