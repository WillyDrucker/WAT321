import * as vscode from "vscode";

/**
 * One-time consent helper for WAT321 interactive-tier tools.
 *
 * Interactive tools may write outside `~/.wat321/` (e.g. to `~/.claude/`
 * or `~/.codex/`), which breaks the read-only guarantee of the core
 * widgets. The first time the user exercises an interactive tool, we
 * show a non-modal notification toast explaining what the tool will do.
 * Non-modal keeps the flow consistent with VS Code's native notification
 * UX and avoids the "out of nowhere dialog" feeling of a modal. The
 * user's decision is persisted via globalState so the prompt is never
 * shown twice for the same tool.
 *
 * Declining does NOT revert the calling setting by default. A user who
 * enabled the setting deliberately should not be silently unchecked
 * just because they cancelled one specific use of the tool. Callers
 * can opt into reverting by passing `settingToRevert` if they want the
 * traditional "decline = turn off" behavior.
 */
export interface ConsentRequest {
  /** Unique key for persistence, e.g. "claudeForceAutoCompact", "bridge". */
  toolKey: string;
  /** Short human-friendly title shown in the notification header. */
  title: string;
  /** Full explanation shown in the notification body. */
  body: string;
  /** Label for the accept button. */
  acceptLabel: string;
  /**
   * Optional. When provided, declining the consent will flip this
   * setting back to false. Omit to leave the user's setting untouched
   * on decline (recommended for most interactive tools).
   */
  settingToRevert?: string;
}

const CONSENT_KEY_PREFIX = "wat321.consent.";

/**
 * Check if the user has previously granted consent for this tool.
 * Returns true if already granted, false otherwise.
 */
export function hasConsent(
  context: vscode.ExtensionContext,
  toolKey: string
): boolean {
  return context.globalState.get<boolean>(CONSENT_KEY_PREFIX + toolKey, false);
}

/**
 * Show a non-modal consent notification and record the user's decision.
 *
 * Returns true if the user accepted, false if they declined or dismissed.
 * When `settingToRevert` is provided, declining also flips that setting
 * back to false. By default, declining leaves the user's settings alone.
 */
export async function requestConsent(
  context: vscode.ExtensionContext,
  request: ConsentRequest
): Promise<boolean> {
  if (hasConsent(context, request.toolKey)) {
    return true;
  }

  // VS Code's information-message header already renders the first
  // sentence prominently, so we show only the body. Prepending the
  // title caused a visible duplicate ("Claude Force Auto-Compact" once
  // as the header, once as the first words of the body paragraph).
  // The `title` field is retained on the request interface for
  // telemetry / accessibility surfaces that don't read the body.
  const choice = await vscode.window.showInformationMessage(
    request.body,
    request.acceptLabel,
    "Cancel"
  );

  if (choice === request.acceptLabel) {
    await context.globalState.update(CONSENT_KEY_PREFIX + request.toolKey, true);
    return true;
  }

  // Declined or dismissed. Only revert the setting if the caller asked
  // for that behavior - most interactive tools should leave the setting
  // enabled so a repeat click re-prompts rather than forcing the user to
  // re-toggle the setting.
  if (request.settingToRevert) {
    await vscode.workspace
      .getConfiguration("wat321")
      .update(
        request.settingToRevert,
        false,
        vscode.ConfigurationTarget.Global
      );
  }
  return false;
}

/**
 * Clear a consent record. Used by the clearAllSettings reset flow so
 * the user is re-prompted on the next enable.
 */
export async function clearConsent(
  context: vscode.ExtensionContext,
  toolKey: string
): Promise<void> {
  await context.globalState.update(CONSENT_KEY_PREFIX + toolKey, undefined);
}
