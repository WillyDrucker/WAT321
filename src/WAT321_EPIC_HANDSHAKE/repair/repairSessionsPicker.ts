import * as vscode from "vscode";
import {
  listKnownCodexSlugs,
  preferredRepairSlug,
} from "../../shared/providers/codex/models";
import { ensureCodexCatalog } from "../codexSettings/codexCatalogRefresh";
import { epicHandshakeLogger } from "../epicHandshakeLogger";
import { runForceRepairFlow } from "./forceRepairFlow";
import { showRepairOutcome } from "./repairOutcomeToast";
import {
  applyRepairs,
  findRepairableSessions,
  type RepairCandidate,
} from "./repairSessionsScan";
import type { RecoverableSession } from "../codexTurn/sessionRecovery";
import { loadBridgeThreadRecord } from "../codexTurn/threadRecord";

/**
 * Repair Sessions sub-picker. Surfaces sessions whose stored
 * `session_meta.model` is no longer a model the installed Codex can run
 * (drifted across a CLI upgrade or a server-side retirement that
 * dropped the slug). Each session repairs onto the successor Codex
 * names for its old slug when the running app-server lists it, else
 * onto Codex's default. When Codex claims everything is valid but
 * prompts still fail, `forceRepairFlow.ts` takes over. The scan and
 * the rewrite live in `repairSessionsScan.ts`, and the shared submenu
 * in `menuPickers.ts` calls its `findRepairableSessions` to render the
 * conditional REPAIR row count.
 *
 * Repairing rewrites the rollout AND repins the live session, because
 * `turn/start` re-sends the pinned model on every turn and would
 * otherwise resurrect the bad slug.
 */
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
    await runForceRepairFlow(workspacePath, sessions, knownSlugs);
    return;
  }

  // One target per session: a retired slug goes to the successor Codex
  // names for it, anything else to Codex's default. The default is the
  // last resort for every entry, so a null anywhere means no app-server
  // answered at all.
  const plan = repairable.map((r) => ({
    ...r,
    target: preferredRepairSlug(r.badSlug),
  }));
  const planned = plan.filter(
    (p): p is RepairCandidate & { target: string } => p.target !== null
  );
  if (planned.length !== plan.length) {
    void vscode.window.showErrorMessage(
      "Epic Handshake: Codex could not be reached, so a repair target cannot be suggested right now."
    );
    return;
  }
  const targets = [...new Set(planned.map((p) => p.target))].join(", ");
  const summary = planned
    .map((r) => `S${r.session.sessionCounter}: ${r.badSlug} -> ${r.target}`)
    .join("; ");

  const confirm = await vscode.window.showWarningMessage(
    `Repair ${planned.length} Codex session${
      planned.length === 1 ? "" : "s"
    }? Each session's stored model slug will be rewritten to the model Codex recommends in its place. Targets: ${summary}.`,
    "Repair all",
    "Cancel"
  );
  if (confirm !== "Repair all") return;

  const outcome = applyRepairs(
    planned.map((p) => ({
      session: p.session,
      rolloutPath: p.rolloutPath,
      fromSlug: p.badSlug,
      target: p.target,
    })),
    workspacePath
  );
  showRepairOutcome(outcome, "repaired", targets);
}
