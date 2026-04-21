import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { CODEX_FULL_ACCESS_FLAG_PATH, sentClaudeDir } from "./constants";
import { listLateReplies, type LateReply } from "./lateReplyInbox";
import {
  makeBackItem,
  makeCancelItem,
  makePauseResumeItem,
  withMenuLifecycle,
  type Action,
  type DispatchAction,
  type Item,
} from "./menuCommon";
import { currentWorkspacePath, isPaused } from "./statusBarState";
import {
  loadBridgeThreadRecord,
  recoverBridgeThread,
  type RecoverableSession,
} from "./threadPersistence";
import {
  readNewestHeartbeat,
  renderStageTooltipBlock,
} from "./turnHeartbeat";
import { workspaceHash } from "./workspaceHash";

/** Build the "Bridge status" info item shown at the top of every
 * menu. Stage block renders in `detail`, which VS Code expands when
 * the first item is auto-focused on menu open. Same item across
 * main + all submenus so the user sees consistent live status
 * regardless of where they drilled in. */
function makeStatusItem(ws: string | null, inFlight: boolean): Item {
  const wsHash = ws ? workspaceHash(ws) : null;
  const hb = wsHash ? readNewestHeartbeat(wsHash) : null;
  const paused = isPaused();
  const detail = hb
    ? renderStageTooltipBlock(hb, Date.now())
    : paused
      ? "Bridge paused. Resume via the menu below."
      : inFlight
        ? "Turn starting. Details populate on the next heartbeat."
        : "Bridge idle. Send a Claude to Codex prompt to start a turn.";
  const description = hb
    ? `Stage ${hb.stage}`
    : paused
      ? "(paused)"
      : inFlight
        ? "(turn starting...)"
        : "(idle)";
  return {
    label: "Bridge status",
    description,
    detail,
    iconPath: new vscode.ThemeIcon("info"),
    action: "show-status",
  };
}

/**
 * Sub-pickers for Manage Codex Sessions, Recover, and Late Replies.
 * Each takes a `dispatch` callback so it can route Pause/Resume/Cancel/
 * Back through the same `handleAction` surface as the main menu without
 * a circular import back into `statusBarMenus.ts`.
 */

export async function showSessionsSubmenu(opts: {
  ws: string | null;
  inFlight: boolean;
  recoverable: RecoverableSession[];
  dispatch: DispatchAction;
}): Promise<void> {
  const paused = isPaused();
  const pauseItem = makePauseResumeItem(paused, opts.inFlight);
  const cancelItem = makeCancelItem(opts.inFlight);

  // Codex permissions toggle. State lives in a flag file (no settings
  // UI clutter). Click flips Read-Only <-> Full-Access. The new value
  // takes effect on the NEXT thread spawn (reset / delete / first
  // prompt after rotate); existing thread keeps its current sandbox
  // because Codex's app-server doesn't allow mid-session change.
  const isFullAccess = existsSync(CODEX_FULL_ACCESS_FLAG_PATH);
  const permissionsItem: Item = {
    label: `Codex permissions: ${isFullAccess ? "Full-Access" : "Read-Only"}`,
    description: `Click to switch to ${isFullAccess ? "Read-Only" : "Full-Access"}.`,
    detail: isFullAccess
      ? "Full filesystem + shell access. Faster on research turns. Use only on machines you own."
      : "Codex can read files but cannot run shell commands or write. Safest. Slower because Codex chains web searches when shell tools are blocked.",
    iconPath: new vscode.ThemeIcon("shield"),
    action: "permissions-toggle",
  };

  const resetItem: Item = {
    label: "Reset Codex Session (Soft)",
    description: "Bump counter; fresh session on next prompt.",
    detail: "Keeps the old Codex session visible in Codex's own history.",
    iconPath: new vscode.ThemeIcon("refresh"),
    action: "reset",
  };

  const deleteItem: Item = {
    label: "Delete Codex Session",
    description: "Permanent. Fresh session on next prompt.",
    detail: "Removes the rollout file and strips the index entry.",
    iconPath: new vscode.ThemeIcon("trash"),
    action: "delete",
  };

  // Include the live count in the label so the user sees exactly how
  // many sessions the bulk delete will touch before committing.
  const deleteAllItem: Item = {
    label: `Delete All Codex Sessions (${opts.recoverable.length})`,
    description:
      opts.recoverable.length === 0
        ? "No Codex bridge sessions found for this workspace."
        : "Permanently remove every Codex bridge session for this workspace.",
    detail:
      opts.recoverable.length === 0
        ? "Nothing to clear right now."
        : `Deletes ${opts.recoverable.length} session${opts.recoverable.length === 1 ? "" : "s"} including all rollouts and index entries. Next prompt spawns a fresh session.`,
    iconPath: new vscode.ThemeIcon("trash"),
    action: "delete-all",
  };

  const recoverItem: Item | null =
    opts.recoverable.length > 0
      ? {
          label: `Recover Codex Session (${opts.recoverable.length})`,
          description: "Reattach to a prior Epic Handshake session.",
          detail: "Stale entries (rollout deleted) are filtered out.",
          iconPath: new vscode.ThemeIcon("history"),
          action: "recover",
        }
      : null;

  // Ordering: Bridge status first (auto-focused, detail expands on
  // open so user sees live stage info without hover). Back next,
  // then permissions toggle, then session-management actions, then
  // Pause + Cancel paired at the bottom.
  const items: Item[] = [
    makeStatusItem(opts.ws, opts.inFlight),
    makeBackItem(),
    permissionsItem,
    resetItem,
    deleteItem,
    deleteAllItem,
    ...(recoverItem ? [recoverItem] : []),
    ...(pauseItem ? [pauseItem] : []),
    ...(cancelItem ? [cancelItem] : []),
  ];

  const pick = await withMenuLifecycle(() =>
    vscode.window.showQuickPick(items, {
      title: `Manage Codex Sessions${paused ? " (paused)" : ""}`,
      placeHolder: "Choose an action",
    })
  );
  if (!pick) return;

  await opts.dispatch(pick.action, {
    ws: opts.ws,
    lateReplies: [],
    recoverable: opts.recoverable,
    inFlight: opts.inFlight,
  });
}

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
      label: `S${s.sessionCounter}${isActive ? " (current)" : ""}`,
      detail: `${s.displayName} - thread ${s.threadId.slice(0, 12)}...`,
      session: s,
    };
    if (s.createdAt) item.description = new Date(s.createdAt).toLocaleString();
    return item;
  });

  const statusItem = makeStatusItem(workspacePath, inFlight);
  const items: RecoverPick[] = [
    { ...statusItem, rowKind: "action" as const },
    { ...makeBackItem(), rowKind: "action" as const },
    ...sessionItems,
    ...(pauseItem ? [{ ...pauseItem, rowKind: "action" as const }] : []),
    ...(cancelItem ? [{ ...cancelItem, rowKind: "action" as const }] : []),
  ];

  const pick = await withMenuLifecycle(() =>
    vscode.window.showQuickPick<RecoverPick>(items, {
      title: `Recover Codex Session${paused ? " (paused)" : ""}`,
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

export async function discardAllLateReplies(
  replies: LateReply[]
): Promise<void> {
  if (replies.length === 0) return;
  const label = `Discard ${replies.length} late ${
    replies.length > 1 ? "replies" : "reply"
  }?`;
  const confirm = await vscode.window.showWarningMessage(
    label,
    {
      modal: true,
      detail:
        "Replies move out of the inbox unread, so nothing auto-delivers on your next Claude to Codex prompt. Files stay in sent/ until the 1-hour sweep if you change your mind.",
    },
    "Discard"
  );
  if (confirm !== "Discard") return;

  const ws = currentWorkspacePath();
  if (!ws) return;
  const sentDir = sentClaudeDir(workspaceHash(ws));
  if (!existsSync(sentDir)) mkdirSync(sentDir, { recursive: true });
  let moved = 0;
  for (const r of replies) {
    try {
      renameSync(r.fullPath, join(sentDir, r.filename));
      moved++;
    } catch {
      // best-effort
    }
  }
  void vscode.window.showInformationMessage(
    `Discarded ${moved} late ${moved === 1 ? "reply" : "replies"}.`
  );
}

export async function showLateRepliesPicker(
  initialReplies: LateReply[],
  inFlight: boolean,
  dispatch: DispatchAction
): Promise<void> {
  // Loop so the user can retrieve multiple replies without re-opening
  // the main menu between each. Re-reads the inbox each iteration so
  // any reply that arrived while the picker was open surfaces too.
  let replies = initialReplies;
  while (replies.length > 0) {
    const paused = isPaused();
    const pauseItem = makePauseResumeItem(paused, inFlight);
    const cancelItem = makeCancelItem(inFlight);

    type RepliesPick =
      | (vscode.QuickPickItem & { rowKind: "reply"; reply: LateReply })
      | (vscode.QuickPickItem & { rowKind: "action"; action: Action });

    const replyItems: RepliesPick[] = replies.map((r) => ({
      rowKind: "reply",
      label: `${r.intent} reply (${r.sizeKb} KB)`,
      description: r.createdAt
        ? new Date(r.createdAt).toLocaleTimeString()
        : "",
      detail:
        r.body.slice(0, 200).replace(/\s+/g, " ") +
        (r.body.length > 200 ? "..." : ""),
      iconPath: new vscode.ThemeIcon("wat321-square-mail"),
      reply: r,
    }));

    const discardItem: RepliesPick = {
      rowKind: "action",
      label: `Discard all remaining (${replies.length})`,
      description: "Clear the inbox without reading.",
      detail: "Confirmation required.",
      iconPath: new vscode.ThemeIcon("trash"),
      action: "discard-mail",
    };

    const statusItem = makeStatusItem(currentWorkspacePath(), inFlight);
    const items: RepliesPick[] = [
      { ...statusItem, rowKind: "action" as const },
      { ...makeBackItem(), rowKind: "action" as const },
      ...replyItems,
      discardItem,
      ...(pauseItem ? [{ ...pauseItem, rowKind: "action" as const }] : []),
      ...(cancelItem ? [{ ...cancelItem, rowKind: "action" as const }] : []),
    ];

    const pick = await withMenuLifecycle(() =>
      vscode.window.showQuickPick<RepliesPick>(items, {
        title: `Late Codex replies (${replies.length})${paused ? " - paused" : ""}`,
        placeHolder: "Pick a reply to copy, or choose an action",
      })
    );
    if (!pick) return;

    if (pick.rowKind === "action") {
      await dispatch(pick.action, {
        ws: currentWorkspacePath(),
        lateReplies: replies,
        recoverable: [],
        inFlight,
      });
      // Pause/Resume/Cancel: user's done with retrieval for now.
      // Discard: handler already cleared; exit.
      return;
    }

    await vscode.env.clipboard.writeText(pick.reply.body);

    // Move envelope out of inbox so the mail icon clears and the
    // next refresh does not re-surface the same reply.
    try {
      const wsForMove = currentWorkspacePath();
      if (wsForMove) {
        const sentDir = sentClaudeDir(workspaceHash(wsForMove));
        if (!existsSync(sentDir)) mkdirSync(sentDir, { recursive: true });
        renameSync(pick.reply.fullPath, join(sentDir, pick.reply.filename));
      }
    } catch {
      // best-effort
    }

    void vscode.window.showInformationMessage(
      `Reply copied to clipboard (${pick.reply.sizeKb} KB). Paste into your Claude prompt to share it with Claude.`
    );

    // Refresh and loop so remaining replies stay accessible.
    const wsForRefresh = currentWorkspacePath();
    replies = wsForRefresh ? listLateReplies(wsForRefresh) : [];
  }
}
