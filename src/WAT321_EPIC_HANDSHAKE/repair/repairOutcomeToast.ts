import * as vscode from "vscode";
import type { RepairOutcome } from "./repairSessionsScan";

/**
 * The one toast both repair paths end on: how many sessions were
 * rewritten and, when a rewrite failed, which ones and the usual
 * Windows cause.
 */
export function showRepairOutcome(
  outcome: RepairOutcome,
  verb: "repaired" | "force-repaired",
  targets: string
): void {
  if (outcome.failed.length === 0) {
    void vscode.window.showInformationMessage(
      `Epic Handshake: ${verb} ${outcome.repaired} session${
        outcome.repaired === 1 ? "" : "s"
      } to ${targets}. Next Claude to Codex prompt will resume on the new model.`
    );
    return;
  }
  const failList = outcome.failed
    .map((f) => `S${f.counter} (${f.slug ?? "(unreadable)"})`)
    .join(", ");
  void vscode.window.showWarningMessage(
    `Epic Handshake: ${verb} ${outcome.repaired}, ${outcome.failed.length} failed (${failList}). On Windows, failures usually mean Codex still has the file open - try again with the bridge idle.`
  );
}
