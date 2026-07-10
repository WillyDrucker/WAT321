import * as vscode from "vscode";
import {
  defaultCodexModelSlug,
  isKnownCodexModel,
  listKnownCodexSlugs,
  preferredRepairSlug,
} from "../shared/providers/codex/models";
import { writeSessionModel } from "./codexSessionSettings";
import {
  bridgeThreadDisplayName,
  findRolloutPath,
  loadBridgeThreadRecord,
  readRolloutModelSlug,
  rewriteRolloutModelSlug,
  type RecoverableSession,
} from "./threadPersistence";
import { ensureCodexCatalog } from "./codexCatalogSync";
import { epicHandshakeLogger } from "./outputChannel";

/**
 * Repair Sessions sub-picker plus the scanning helpers it depends on.
 * Surfaces sessions whose stored `session_meta.model` is no longer a
 * model the installed Codex can run (drifted across a CLI upgrade that
 * renamed or retired that slug). Validity comes from the live
 * `model/list` catalog, never from `~/.codex/models_cache.json`, which
 * any codex on the machine may have overwritten. Falls back to a
 * force-repair input box when Codex claims everything is valid but
 * prompts still fail.
 *
 * Repairing rewrites the rollout AND repins the live session, because
 * `turn/start` re-sends the pinned model on every turn and would
 * otherwise resurrect the bad slug.
 *
 * The shared submenu in `menuPickers.ts` calls `findRepairableSessions`
 * to render its conditional REPAIR row count.
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

/** Repoint the workspace's session pin at a repaired slug.
 *
 * Rewriting the rollout alone is not enough. `thread/resume` reads the
 * rollout, but every `turn/start` re-sends `readSessionPin().model`, so a
 * session left pinned to the bad slug would 404 on its very next turn
 * while the repair reported success. Only the CURRENTLY active thread
 * has a pin - older sessions in the scan are rollouts on disk with no
 * record pointing at them. */
function repinIfCurrentSession(
  workspacePath: string | null,
  threadId: string,
  target: string
): void {
  if (workspacePath === null) return;
  if (loadBridgeThreadRecord(workspacePath).threadId !== threadId) return;
  writeSessionModel(workspacePath, target);
}

/** Apply a forced slug rewrite to every scanned session, skipping
 * validation. Used when the installed Codex wrongly claims every slug is
 * valid (it sometimes advertises speculative model IDs the API does not
 * serve). Same atomic tmp+rename mechanics as the auto-repair path, and
 * it repins the live session so the next turn does not undo the fix. */
function applyForcedRepair(
  scan: BridgeSessionScan[],
  target: string,
  workspacePath: string | null
): { repaired: number; failed: Array<{ counter: number; slug: string | null }> } {
  let repaired = 0;
  const failed: Array<{ counter: number; slug: string | null }> = [];
  for (const entry of scan) {
    const ok = rewriteRolloutModelSlug(entry.rolloutPath, target);
    if (ok) {
      repaired++;
      repinIfCurrentSession(workspacePath, entry.session.threadId, target);
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
export function findRepairableSessions(
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

  // Repair decides whether a stored model slug is still valid, and only
  // the running app-server can answer that. Without this the catalog may
  // be empty and every session would report "cannot validate".
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "WAT321: reading Codex models",
    },
    () => ensureCodexCatalog(epicHandshakeLogger())
  );

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
        "Epic Handshake: Codex could not be reached, so session models cannot be checked right now. Repair will work once Codex is available."
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

    const detail = `${scan.length} bridge session${scan.length === 1 ? "" : "s"} scanned. Every stored slug is one the installed Codex says it can run.\n\nScanned sessions:\n${sessionsSummary}\n\nCodex reports ${knownSlugs.length} model${knownSlugs.length === 1 ? "" : "s"}: ${cacheSummary}\n\nIf sessions are still failing with "model does not exist" errors, Codex is advertising a model the API does not actually serve. Use Force Repair to rewrite every scanned session to a slug you type in manually, skipping validation.`;

    const choice = await vscode.window.showInformationMessage(
      `Epic Handshake: all ${scan.length} bridge session${scan.length === 1 ? "" : "s"} look valid, but your prompts may still be failing.`,
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

    const placeholder = defaultCodexModelSlug() ?? knownSlugs[0] ?? "gpt-5-codex";
    const typed = await vscode.window.showInputBox({
      title: "Force Repair: target model slug",
      prompt: "Every scanned bridge session will be rewritten to this slug. Skips validation against the installed Codex.",
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
      `Force-repair ${scan.length} Codex session${scan.length === 1 ? "" : "s"} to "${forcedTarget}"? Skips validation against the installed Codex. Targets: ${forceSummary.replace(/\n/g, "; ")}`,
      "Force Repair",
      "Cancel"
    );
    if (forceConfirm !== "Force Repair") return;

    const forceResult = applyForcedRepair(scan, forcedTarget, workspacePath);
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
      "Epic Handshake: Codex could not be reached, so a repair target cannot be suggested right now."
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
      repinIfCurrentSession(workspacePath, entry.session.threadId, target);
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
