import * as vscode from "vscode";
import { rememberUnlistedPin } from "../../shared/providers/codex/unlistedModelPins";
import { isKnownCodexModel, defaultCodexModelSlug } from "../../shared/providers/codex/models";
import { showRepairOutcome } from "./repairOutcomeToast";
import { applyRepairs, scanBridgeSessions } from "./repairSessionsScan";
import type { RecoverableSession } from "../codexTurn/sessionRecovery";

/**
 * The path Repair Sessions takes when the catalog says every stored
 * slug is valid but the user's prompts still fail. Codex sometimes
 * advertises speculative model IDs the API does not serve, so this
 * shows exactly what is on disk and offers a force repair that
 * rewrites every scanned session to a slug the user types, skipping
 * validation. Same atomic rewrite and repin as the auto path.
 */

/** How many catalog slugs the details dump names before eliding. */
const CATALOG_PREVIEW_COUNT = 12;

export async function runForceRepairFlow(
  workspacePath: string | null,
  sessions: RecoverableSession[],
  knownSlugs: string[]
): Promise<void> {
  const scan = scanBridgeSessions(workspacePath, sessions);
  const plural = scan.length === 1 ? "" : "s";
  const sessionsSummary = scan
    .map(
      (s) =>
        `  S${s.session.sessionCounter} (${s.session.threadId.slice(0, 8)}...) -> ${s.storedSlug ?? "(unreadable)"}`
    )
    .join("\n");
  const cachePreview = knownSlugs.slice(0, CATALOG_PREVIEW_COUNT).join(", ");
  const cacheSummary =
    knownSlugs.length <= CATALOG_PREVIEW_COUNT
      ? cachePreview
      : `${cachePreview}, +${knownSlugs.length - CATALOG_PREVIEW_COUNT} more`;

  const detail = `${scan.length} bridge session${plural} scanned. Every stored slug is one the installed Codex says it can run.\n\nScanned sessions:\n${sessionsSummary}\n\nCodex reports ${knownSlugs.length} model${knownSlugs.length === 1 ? "" : "s"}: ${cacheSummary}\n\nIf sessions are still failing with "model does not exist" errors, Codex is advertising a model the API does not actually serve. Use Force Repair to rewrite every scanned session to a slug you type in manually, skipping validation.`;

  const choice = await vscode.window.showInformationMessage(
    `Epic Handshake: all ${scan.length} bridge session${plural} look valid, but your prompts may still be failing.`,
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

  const placeholder = defaultCodexModelSlug() ?? knownSlugs[0] ?? "";
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
    .join("; ");
  const forceConfirm = await vscode.window.showWarningMessage(
    `Force-repair ${scan.length} Codex session${plural} to "${forcedTarget}"? Skips validation against the installed Codex. Targets: ${forceSummary}`,
    "Force Repair",
    "Cancel"
  );
  if (forceConfirm !== "Force Repair") return;

  const outcome = applyRepairs(
    scan.map((s) => ({
      session: s.session,
      rolloutPath: s.rolloutPath,
      fromSlug: s.storedSlug,
      target: forcedTarget,
    })),
    workspacePath
  );
  // Force Repair skips validation on purpose, but pre-flight on the
  // next resume does not. Pin the slug the way the model picker pins a
  // hand-typed one so the API, not the catalog, gives the verdict.
  if (!isKnownCodexModel(forcedTarget)) rememberUnlistedPin(forcedTarget);
  showRepairOutcome(outcome, "force-repaired", `"${forcedTarget}"`);
}
