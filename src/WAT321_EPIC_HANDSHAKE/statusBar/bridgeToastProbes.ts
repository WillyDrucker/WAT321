import { existsSync } from "node:fs";
import * as vscode from "vscode";
import {
  setBridgeActiveProbe,
  setRecentCodexCompletionConsumer,
} from "../../engine/toastNotifier";
import { workspaceHash } from "../../engine/workspaceHash";
import {
  inFlightFlagPath,
  processingFlagPath,
  returningFlagPath,
} from "../epicHandshakePaths";
import { consumeRecentCodexCompletion } from "../codexTurn/turnFlags";

/**
 * Wire the engine-side toast notifier probes so the notifier can ask
 * "is this workspace's bridge active?" and drain the one-shot
 * completion sentinel without importing from this tier. Preserves the
 * engine-depends-on-nothing rule. The returned disposable unwires both.
 */
export function wireBridgeToastProbes(): vscode.Disposable {
  setBridgeActiveProbe(() => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return false;
    const hash = workspaceHash(ws);
    return (
      existsSync(inFlightFlagPath(hash)) ||
      existsSync(processingFlagPath(hash)) ||
      existsSync(returningFlagPath(hash))
    );
  });
  // Consume-on-read complement: the dispatcher writes a one-shot
  // suppress sentinel on successful turn complete - the notifier
  // drains it when Codex's transcript responseComplete fires
  // (which can land >5s after the returning flag clears).
  setRecentCodexCompletionConsumer(() => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return false;
    return consumeRecentCodexCompletion(ws);
  });
  return {
    dispose: () => {
      setBridgeActiveProbe(null);
      setRecentCodexCompletionConsumer(null);
    },
  };
}
