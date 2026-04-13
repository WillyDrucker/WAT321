import * as vscode from "vscode";
import type { ActiveGroups } from "../bootstrap";

/**
 * Internal wake commands for the Claude and Codex usage widgets.
 *
 * These are NOT listed under `contributes.commands` in `package.json`,
 * so they do not appear in the command palette. They exist purely as
 * a target for the status bar widget's `item.command` when the widget
 * is in the 15-minute fallback rate-limited state. Clicking the widget
 * (the only affordance) invokes the command, which in turn calls
 * `service.wake()` to transition out of the fallback back to normal
 * polling.
 *
 * Philosophically: this is NOT a user-facing "refresh" lever. The
 * widget only becomes clickable when WAT321 is guessing at a wait
 * time (no `Retry-After` header from the server). The user clicks
 * to correct our conservative guess, not to override a
 * server-directed wait. A server-directed backoff (`source: "server"`)
 * leaves the widget hover-only with `item.command = undefined`.
 *
 * `service.wake()` is a no-op unless the service is currently in the
 * `rate-limited` state with `source === "fallback"`, so the commands
 * are safe to invoke unconditionally from any widget state - a stale
 * click after the state flipped to something else silently does
 * nothing.
 */
export function registerWakeCommands(
  context: vscode.ExtensionContext,
  groups: ActiveGroups
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("wat321.wakeClaudeUsage", () => {
      groups.claude?.usageService.wake();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("wat321.wakeCodexUsage", () => {
      groups.codex?.usageService.wake();
    })
  );
}
