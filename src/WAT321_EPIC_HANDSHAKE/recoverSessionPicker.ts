import * as vscode from "vscode";
import {
  makeBackItem,
  makeCancelItem,
  makePauseResumeItem,
  withMenuLifecycle,
  type Action,
  type DispatchAction,
} from "./menuCommon";
import { isPaused } from "./statusBarState";
import {
  loadBridgeThreadRecord,
  recoverBridgeThread,
  type RecoverableSession,
} from "./threadPersistence";

/**
 * Switch-to-recoverable-session sub-picker. Opens from the CODEX
 * SESSION row in `showSessionsSubmenu`. The active session is marked
 * with a leading green check; selecting a different one rewrites
 * `bridge-thread.<wshash>.json#threadId` so the next prompt resumes
 * that session instead of the previously-active one.
 *
 * BACK from this picker walks back to the parent submenu, not the
 * main menu. The dispatch contract is shared with all EH pickers so
 * Pause/Resume/Cancel route through the same `handleAction` surface.
 */

export async function showRecoverSessionPicker(
  workspacePath: string,
  sessions: RecoverableSession[],
  inFlight: boolean,
  dispatch: DispatchAction
): Promise<void> {
  if (sessions.length === 0) return;
  const current = loadBridgeThreadRecord(workspacePath);
  const paused = isPaused();
  const pauseItem = makePauseResumeItem(paused, inFlight);
  const cancelItem = makeCancelItem(inFlight);

  type RecoverPick =
    | (vscode.QuickPickItem & {
        rowKind: "session";
        session: RecoverableSession;
      })
    | (vscode.QuickPickItem & { rowKind: "action"; action: Action });

  const sessionItems: RecoverPick[] = sessions.map((s) => {
    const isActive = s.threadId === current.threadId;
    const item: RecoverPick = {
      rowKind: "session",
      label: `${isActive ? "✔️ " : ""}S${s.sessionCounter}`,
      detail: `${s.displayName} - thread ${s.threadId.slice(0, 12)}...`,
      session: s,
    };
    if (s.createdAt) item.description = new Date(s.createdAt).toLocaleString();
    return item;
  });

  const items: RecoverPick[] = [
    // BACK from this picker walks back to the sessions submenu
    // (its parent), not straight to main. Override the action so
    // the dispatch handler routes correctly.
    { ...makeBackItem(), action: "manage-sessions" as Action, rowKind: "action" as const },
    ...sessionItems,
    { ...pauseItem, rowKind: "action" as const },
    { ...cancelItem, rowKind: "action" as const },
  ];

  const pick = await withMenuLifecycle(() =>
    vscode.window.showQuickPick<RecoverPick>(items, {
      title: `Switch Codex session${paused ? " (paused)" : ""}`,
      placeHolder: "Pick a previous Codex session to reattach the bridge to",
    })
  );
  if (!pick) return;

  if (pick.rowKind === "action") {
    await dispatch(pick.action, {
      ws: workspacePath,
      lateReplies: [],
      recoverable: sessions,
      inFlight,
    });
    return;
  }

  if (pick.session.threadId === current.threadId) {
    void vscode.window.showInformationMessage(
      `Epic Handshake: already attached to S${pick.session.sessionCounter}.`
    );
    return;
  }
  recoverBridgeThread(workspacePath, pick.session);
  void vscode.window.showInformationMessage(
    `Epic Handshake: reattached to S${pick.session.sessionCounter}. Next Claude to Codex prompt resumes this session.`
  );
}
