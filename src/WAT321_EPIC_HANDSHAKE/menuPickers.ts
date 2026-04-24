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
  isKnownCodexModel,
  listKnownCodexSlugs,
  preferredRepairSlug,
  readCodexConfigModel,
} from "../shared/codexModels";
import {
  bridgeThreadDisplayName,
  findRolloutPath,
  loadBridgeThreadRecord,
  readRolloutModelSlug,
  recoverBridgeThread,
  rewriteRolloutModelSlug,
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

interface RepairCandidate {
  session: RecoverableSession;
  rolloutPath: string;
  badSlug: string;
}

/** Every bridge session the scan considered, whether or not its
 * stored slug tripped the cache check. Used by the diagnostic /
 * force-repair path to show the user exactly what's on disk when
 * the auto-detect result seems wrong. */
interface BridgeSessionScan {
  session: RecoverableSession;
  rolloutPath: string;
  storedSlug: string | null;
}

function scanBridgeSessions(
  workspacePath: string | null,
  sessions: RecoverableSession[]
): BridgeSessionScan[] {
  const out: BridgeSessionScan[] = [];
  const seen = new Set<string>();
  const consider = (session: RecoverableSession): void => {
    if (seen.has(session.threadId)) return;
    seen.add(session.threadId);
    const rolloutPath = findRolloutPath(session.threadId);
    if (rolloutPath === null) return;
    const storedSlug = readRolloutModelSlug(rolloutPath);
    out.push({ session, rolloutPath, storedSlug });
  };
  for (const session of sessions) consider(session);
  if (workspacePath !== null) {
    const rec = loadBridgeThreadRecord(workspacePath);
    if (rec.threadId !== null) {
      consider({
        threadId: rec.threadId,
        sessionCounter: rec.sessionCounter,
        displayName: bridgeThreadDisplayName(workspacePath, rec.sessionCounter),
        createdAt: null,
      });
    }
  }
  return out;
}

/** Apply a forced slug rewrite to every scanned session, bypassing
 * cache-based validation. Used when the cache wrongly claims every
 * slug is valid (e.g. `gpt-5.5` appearing in a Codex CLI cache that
 * includes speculative/unreleased model metadata). Same atomic
 * tmp+rename mechanics as the auto-repair path. */
function applyForcedRepair(
  scan: BridgeSessionScan[],
  target: string
): { repaired: number; failed: Array<{ counter: number; slug: string | null }> } {
  let repaired = 0;
  const failed: Array<{ counter: number; slug: string | null }> = [];
  for (const entry of scan) {
    const ok = rewriteRolloutModelSlug(entry.rolloutPath, target);
    if (ok) {
      repaired++;
    } else {
      failed.push({
        counter: entry.session.sessionCounter,
        slug: entry.storedSlug,
      });
    }
  }
  return { repaired, failed };
}

/** Return the subset of bridge sessions whose stored `session_meta.model`
 * is not in the local Codex models cache. These are guaranteed to 404
 * on the next `thread/resume`, so the Repair action surfaces them as
 * the candidate set.
 *
 * Two scan sources:
 *   1. `sessions` - everything `listRecoverableSessions` found by
 *      walking `~/.codex/session_index.jsonl`. Misses sessions that
 *      errored at first turn before Codex wrote their index entry.
 *   2. Current `bridge-thread.<wshash>.json` record - captures the
 *      threadId of the session our dispatcher just created, even if
 *      Codex hasn't yet surfaced it in the index. Deduplicated against
 *      the first source by threadId.
 *
 * Sessions whose rollout we can't read (deleted, unreadable) are
 * skipped - delete / reset is the right response for those, not repair. */
function findRepairableSessions(
  workspacePath: string | null,
  sessions: RecoverableSession[]
): RepairCandidate[] {
  const out: RepairCandidate[] = [];
  const seen = new Set<string>();
  const consider = (session: RecoverableSession): void => {
    if (seen.has(session.threadId)) return;
    seen.add(session.threadId);
    const rolloutPath = findRolloutPath(session.threadId);
    if (rolloutPath === null) return;
    const slug = readRolloutModelSlug(rolloutPath);
    if (slug === null) return;
    if (isKnownCodexModel(slug)) return;
    out.push({ session, rolloutPath, badSlug: slug });
  };
  for (const session of sessions) consider(session);
  if (workspacePath !== null) {
    const rec = loadBridgeThreadRecord(workspacePath);
    if (rec.threadId !== null) {
      consider({
        threadId: rec.threadId,
        sessionCounter: rec.sessionCounter,
        displayName: bridgeThreadDisplayName(workspacePath, rec.sessionCounter),
        createdAt: null,
      });
    }
  }
  return out;
}

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
  // UI clutter). Click flips Read-Only <-> Full-Access. Takes effect on
  // the next prompt - turnRunner reads the flag on every `turn/start`,
  // so the existing thread picks up the new sandbox live without a reset.
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

  // Repair surfaces sessions whose stored `session_meta.model` is not
  // in the local Codex models cache (drifted across a Codex CLI
  // upgrade that renamed or retired that slug). Always shown with the
  // live count so the user knows the feature exists even when nothing
  // is broken - same pattern as Delete All. The picker itself handles
  // the zero-case with a friendly info toast, and the in-flight /
  // paused guards are enforced inside the picker rather than hiding
  // the entry.
  const repairable = findRepairableSessions(opts.ws, opts.recoverable);
  const repairItem: Item = {
    label: `Repair sessions (${repairable.length})`,
    description:
      repairable.length === 0
        ? "No sessions need repair right now."
        : "Sessions storing a Codex model your CLI no longer recognizes.",
    detail:
      repairable.length === 0
        ? "Every bridge session's stored model is in your Codex CLI's known set. Open to run diagnostics if you think this is wrong."
        : "Rewrites `session_meta.model` in each rollout to your current Codex default so the session can resume again. Only touches bridge-owned sessions for this workspace.",
    iconPath: new vscode.ThemeIcon("tools"),
    action: "repair-sessions",
  };

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
    repairItem,
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

export async function showRepairSessionsPicker(
  workspacePath: string | null,
  sessions: RecoverableSession[],
  inFlight: boolean
): Promise<void> {
  if (inFlight) {
    void vscode.window.showWarningMessage(
      "Epic Handshake: wait for the current turn to finish before repairing sessions."
    );
    return;
  }

  const repairable = findRepairableSessions(workspacePath, sessions);
  if (repairable.length === 0) {
    // Distinguish the three (0) cases so the user can tell "everything
    // is clean" from "validation couldn't run" from "no sessions to
    // check" - all three produce an empty repairable list but mean
    // very different things.
    const knownSlugs = listKnownCodexSlugs();
    const hasBridgeRecord =
      workspacePath !== null &&
      loadBridgeThreadRecord(workspacePath).threadId !== null;
    const anyScanCandidates = sessions.length > 0 || hasBridgeRecord;

    if (knownSlugs.length === 0) {
      void vscode.window.showWarningMessage(
        "Epic Handshake: can't validate session models. Your Codex `models_cache.json` at `~/.codex/models_cache.json` is missing or empty. Run any Codex command to refresh the cache, then retry Repair."
      );
      return;
    }
    if (!anyScanCandidates) {
      void vscode.window.showInformationMessage(
        "Epic Handshake: no bridge sessions exist for this workspace yet. Send a Claude to Codex prompt to create one."
      );
      return;
    }
    // Cache says every stored slug is valid. If the user is still
    // hitting model-not-found errors, the cache itself is lying (some
    // Codex CLI metadata includes speculative / unreleased slugs
    // that the API does not actually serve). Offer a diagnostic
    // dump and a force-repair override so the user has a guaranteed
    // path forward regardless of what the cache claims.
    const scan = scanBridgeSessions(workspacePath, sessions);
    const sessionsSummary = scan
      .map(
        (s) =>
          `  S${s.session.sessionCounter} (${s.session.threadId.slice(0, 8)}...) -> ${s.storedSlug ?? "(unreadable)"}`
      )
      .join("\n");
    const cachePreview = knownSlugs.slice(0, 12).join(", ");
    const cacheSummary =
      knownSlugs.length <= 12
        ? cachePreview
        : `${cachePreview}, +${knownSlugs.length - 12} more`;

    const detail = `${scan.length} bridge session${scan.length === 1 ? "" : "s"} scanned. All stored slugs match an entry in your \`~/.codex/models_cache.json\`.\n\nScanned sessions:\n${sessionsSummary}\n\nCache (${knownSlugs.length} slug${knownSlugs.length === 1 ? "" : "s"}): ${cacheSummary}\n\nIf sessions are still failing with "model does not exist" errors, the cache is lying (Codex CLI sometimes lists speculative model IDs that the API does not actually serve). Use Force Repair to rewrite every scanned session to a slug you type in manually, bypassing cache validation.`;

    const choice = await vscode.window.showInformationMessage(
      `Epic Handshake: all ${scan.length} bridge session${scan.length === 1 ? "" : "s"} look valid by cache check, but your prompts may still be failing.`,
      { modal: true, detail },
      "Force Repair",
      "Cancel"
    );
    if (choice !== "Force Repair") return;

    const configDefault = readCodexConfigModel();
    const placeholder = configDefault ?? knownSlugs[0] ?? "gpt-5-codex";
    const typed = await vscode.window.showInputBox({
      title: "Force Repair: target model slug",
      prompt: "Every scanned bridge session will be rewritten to this slug. Bypasses cache validation.",
      value: placeholder,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (trimmed.length === 0) return "Slug cannot be empty";
        if (/\s/.test(trimmed)) return "Slug cannot contain whitespace";
        return null;
      },
    });
    if (typed === undefined) return;
    const forcedTarget = typed.trim();

    const forceSummary = scan
      .map(
        (s) =>
          `S${s.session.sessionCounter}: ${s.storedSlug ?? "(unreadable)"} -> ${forcedTarget}`
      )
      .join("\n");
    const forceConfirm = await vscode.window.showWarningMessage(
      `Force-repair ${scan.length} Codex session${scan.length === 1 ? "" : "s"} to "${forcedTarget}"?`,
      {
        modal: true,
        detail: `Each session's stored model slug will be rewritten to "${forcedTarget}" without validating against the models cache. Use this only when you know the slug is correct.\n\n${forceSummary}`,
      },
      "Force Repair",
      "Cancel"
    );
    if (forceConfirm !== "Force Repair") return;

    const forceResult = applyForcedRepair(scan, forcedTarget);
    if (forceResult.failed.length === 0) {
      void vscode.window.showInformationMessage(
        `Epic Handshake: force-repaired ${forceResult.repaired} session${
          forceResult.repaired === 1 ? "" : "s"
        } to "${forcedTarget}". Next Claude to Codex prompt will resume on the new model.`
      );
    } else {
      const failList = forceResult.failed
        .map((f) => `S${f.counter} (${f.slug ?? "(unreadable)"})`)
        .join(", ");
      void vscode.window.showWarningMessage(
        `Epic Handshake: force-repaired ${forceResult.repaired}, ${forceResult.failed.length} failed (${failList}). On Windows, failures usually mean Codex still has the file open - try again with the bridge idle.`
      );
    }
    return;
  }

  const target = preferredRepairSlug();
  if (target === null) {
    void vscode.window.showErrorMessage(
      "Epic Handshake: can't auto-pick a repair target. Your Codex `models_cache.json` is missing or empty. Run any Codex command to refresh the cache, then try again."
    );
    return;
  }

  const summary = repairable
    .map(
      (r) => `S${r.session.sessionCounter}: ${r.badSlug} -> ${target}`
    )
    .join("\n");

  const confirm = await vscode.window.showWarningMessage(
    `Repair ${repairable.length} Codex session${
      repairable.length === 1 ? "" : "s"
    }?`,
    {
      modal: true,
      detail: `Each session's stored model slug will be rewritten to your current Codex default. The conversation history was produced by the old model; after repair, new turns on these sessions will be answered by the new model.\n\n${summary}\n\nOnly bridge-owned rollouts for this workspace are touched. Codex's own cache and index files stay untouched.`,
    },
    "Repair all",
    "Cancel"
  );
  if (confirm !== "Repair all") return;

  let repaired = 0;
  const failed: Array<{ counter: number; badSlug: string }> = [];
  for (const entry of repairable) {
    const ok = rewriteRolloutModelSlug(entry.rolloutPath, target);
    if (ok) {
      repaired++;
    } else {
      failed.push({
        counter: entry.session.sessionCounter,
        badSlug: entry.badSlug,
      });
    }
  }

  if (failed.length === 0) {
    void vscode.window.showInformationMessage(
      `Epic Handshake: repaired ${repaired} session${
        repaired === 1 ? "" : "s"
      } to ${target}. Next Claude to Codex prompt will resume on the new model.`
    );
  } else {
    const failList = failed
      .map((f) => `S${f.counter} (${f.badSlug})`)
      .join(", ");
    void vscode.window.showWarningMessage(
      `Epic Handshake: repaired ${repaired}, ${failed.length} failed (${failList}). On Windows, failures usually mean Codex still has the file open - try again with the bridge idle.`
    );
  }
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
