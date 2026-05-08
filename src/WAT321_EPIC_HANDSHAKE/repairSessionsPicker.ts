import * as vscode from "vscode";
import {
  isKnownCodexModel,
  listKnownCodexSlugs,
  preferredRepairSlug,
  readCodexConfigModel,
} from "../shared/providers/codex/models";
import {
  bridgeThreadDisplayName,
  findRolloutPath,
  loadBridgeThreadRecord,
  readRolloutModelSlug,
  rewriteRolloutModelSlug,
  type RecoverableSession,
} from "./threadPersistence";

/**
 * Repair Sessions sub-picker plus the scanning helpers it depends on.
 * Surfaces sessions whose stored `session_meta.model` is no longer in
 * the local Codex models cache (drifted across a Codex CLI upgrade
 * that renamed or retired that slug). Auto-detects repairable sessions
 * via cache lookup; falls back to a force-repair input box when the
 * cache claims everything is valid but prompts still fail.
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
