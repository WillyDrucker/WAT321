import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { sentClaudeDir } from "./constants";
import { listLateReplies, type LateReply } from "./lateReplyInbox";
import {
  makeBackItem,
  makeCancelItem,
  makePauseResumeItem,
  withMenuLifecycle,
  type Action,
  type DispatchAction,
} from "./menuCommon";
import { currentWorkspacePath, isPaused } from "./statusBarState";
import { workspaceHash } from "./workspaceHash";

/**
 * Late-reply inbox sub-pickers. Replies arriving after a Fire-and-Forget
 * timeout (or any other path that bypassed the synchronous `reply` MCP
 * call) accumulate in `inbox/claude/<wsHash>/`; this module renders them
 * and lets the user copy or bulk-discard.
 *
 * Each picker takes a `dispatch` callback so Pause/Resume/Cancel/Back
 * route through the same `handleAction` surface as the main menu without
 * a circular import back into `statusBarMenus.ts`.
 */

export async function discardAllLateReplies(
  replies: LateReply[]
): Promise<void> {
  if (replies.length === 0) return;
  const label = `Discard ${replies.length} late ${
    replies.length > 1 ? "replies" : "reply"
  }?`;
  const confirm = await vscode.window.showWarningMessage(
    `${label} Replies move out of the inbox unread; files stay in sent/ until the 1-hour sweep.`,
    "Discard",
    "Cancel"
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
      iconPath: new vscode.ThemeIcon("mail"),
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

    const items: RepliesPick[] = [
      { ...makeBackItem(), rowKind: "action" as const },
      ...replyItems,
      discardItem,
      { ...pauseItem, rowKind: "action" as const },
      { ...cancelItem, rowKind: "action" as const },
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
