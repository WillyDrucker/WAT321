import * as vscode from "vscode";
import {
  codexDefaultsHeadline,
  codexDefaultsSubline,
} from "./codexDefaultsPicker";
import {
  makeBackItem,
  makeCancelItem,
  makePauseResumeItem,
  withMenuLifecycle,
  type Action,
  type DispatchAction,
  type Item,
} from "./menuCommon";
import { isBridgeBusy, isPaused } from "./statusBarState";
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

/**
 * Sub-pickers for Manage Codex Sessions, Recover, and Repair. Late-reply
 * inbox sub-pickers live in `lateReplyPickers.ts`. Each takes a `dispatch`
 * callback so it can route Pause/Resume/Cancel/Back through the same
 * `handleAction` surface as the main menu without a circular import back
 * into `statusBarMenus.ts`.
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

  // Codex Defaults entry point. Combined picker for sandbox + model +
  // effort - all three are per-turn overrides on `turn/start`, so the
  // change takes effect on the next prompt without a thread reset.
  // Locks during an in-flight bridge turn because the override flags
  // are read mid-turn; switching while a turn is outstanding would
  // mean the in-flight envelope used different values than the user
  // expected.
  const inFlight = isBridgeBusy(opts.ws);
  const headline = codexDefaultsHeadline();
  const subline = codexDefaultsSubline();
  const codexDefaultsItem: Item = {
    label: inFlight ? `${headline} (locked during turn)` : headline,
    description: subline,
    iconPath: new vscode.ThemeIcon("symbol-method"),
    action: "codex-defaults",
  };

  const resetItem: Item = {
    label: "RESET CODEX SESSION",
    description: "Fresh session on next prompt.",
    detail: "Keeps the old Codex session visible in Codex's own history.",
    iconPath: new vscode.ThemeIcon("refresh"),
    action: "reset",
  };

  const deleteItem: Item = {
    label: "DELETE CODEX SESSION",
    description: "Removes the active session.",
    detail:
      "Removes and deletes the currently active \"Epic Handshake\" session. Next prompt spawns a fresh session.",
    iconPath: new vscode.ThemeIcon("trash"),
    action: "delete",
  };

  const deleteAllItem: Item = {
    label: `DELETE ALL CODEX SESSIONS (${opts.recoverable.length})`,
    description:
      opts.recoverable.length === 0
        ? "Nothing to clear right now."
        : "Removes every bridge session for this workspace.",
    detail:
      opts.recoverable.length === 0
        ? undefined
        : "Deletes all \"Epic Handshake\" sessions for this project. Next prompt spawns a fresh session.",
    iconPath: new vscode.ThemeIcon("trash"),
    action: "delete-all",
  };

  const recoverItem: Item | null =
    opts.recoverable.length > 0
      ? {
          label: `RECOVER CODEX SESSION (${opts.recoverable.length})`,
          description: "Reattach to a prior session.",
          detail: "Reattach to a prior \"Epic Handshake\" session.",
          iconPath: new vscode.ThemeIcon("history"),
          action: "recover",
        }
      : null;

  // Repair surfaces sessions whose stored `session_meta.model` is not
  // in the local Codex models cache (drifted across a Codex CLI
  // upgrade that renamed or retired that slug). Conditional show -
  // hidden when nothing needs repair so the menu stays lean.
  const repairable = findRepairableSessions(opts.ws, opts.recoverable);
  const repairItem: Item | null =
    repairable.length > 0
      ? {
          label: `REPAIR SESSIONS (${repairable.length})`,
          description: "Repair stale sessions.",
          detail:
            "Attempts repairs if \"Epic Handshake\" session is experiencing a problem.",
          iconPath: new vscode.ThemeIcon("tools"),
          action: "repair-sessions",
        }
      : null;

  // Ordering: BACK at top, then the unified Codex Defaults entry
  // (sandbox + model + effort live there), then session-management
  // actions. PAUSE/CANCEL repeat at the bottom of every menu so the
  // user always has a one-click escape path regardless of where they
  // navigated.
  const pauseItem = makePauseResumeItem(paused, opts.inFlight);
  const cancelItem = makeCancelItem(opts.inFlight);
  const items: Item[] = [
    makeBackItem(),
    codexDefaultsItem,
    resetItem,
    deleteItem,
    deleteAllItem,
    ...(recoverItem ? [recoverItem] : []),
    ...(repairItem ? [repairItem] : []),
    pauseItem,
    cancelItem,
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
        "Epic Handshake: Codex's local models cache is empty, so session models can't be validated yet. The cache populates whenever Codex runs; Repair will work once it's available."
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
      "Force Repair",
      "View details",
      "Cancel"
    );
    if (choice === "View details") {
      void vscode.window.showInformationMessage(
        detail.length > 1500 ? `${detail.slice(0, 1500)}...` : detail
      );
      return;
    }
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
      `Force-repair ${scan.length} Codex session${scan.length === 1 ? "" : "s"} to "${forcedTarget}"? Bypasses cache validation. Targets: ${forceSummary.replace(/\n/g, "; ")}`,
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
      "Epic Handshake: Codex's local models cache is empty, so a repair target can't be auto-picked. The cache populates whenever Codex runs."
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
    }? Each session's stored model slug will be rewritten to "${target}". Targets: ${summary.replace(/\n/g, "; ")}.`,
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
