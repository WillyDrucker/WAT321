import * as vscode from "vscode";
import type { ClaudeForceAutoCompactState, StatusBarWidget } from "./types";
import type { ClaudeForceAutoCompactService } from "./service";
import type { ClaudeSessionTokenService } from "../WAT321_CLAUDE_SESSION_TOKENS/service";
import type { WidgetState as ClaudeTokenState } from "../WAT321_CLAUDE_SESSION_TOKENS/types";
import { getWidgetPriority } from "../shared/priority";
import { hasConsent, requestConsent } from "../shared/consent";
import { formatPct, formatTokens } from "../shared/ui/tokenFormatters";
import { enumerateActiveClaudeSessions } from "./activeClaudeSessions";
import { formatArmErrorMessage, formatDisarmMessage } from "./messages";
import {
  buildArmedTooltip,
  buildReadyTooltip,
  buildStaleTooltip,
  truncateTitle,
} from "./tooltips";

const CLAMP = "\u{1F5DC}\u{FE0F}";
const RED_EXCLAM = "\u2757"; // U+2757 HEAVY EXCLAMATION MARK SYMBOL
const COMMAND_ID = "wat321.claudeForceAutoCompact";

interface ClaudeSessionDescriptor {
  sessionId: string;
  label: string;
  sessionTitle: string;
  contextUsed: number;
  contextWindowSize: number;
  autoCompactPct: number;
  source: "live" | "lastKnown";
}

export class ClaudeForceAutoCompactWidget implements StatusBarWidget {
  private item: vscode.StatusBarItem;
  private currentClaudeSession: ClaudeSessionDescriptor | null = null;
  private currentServiceState: ClaudeForceAutoCompactState = { status: "not-installed" };

  constructor(
    private service: ClaudeForceAutoCompactService,
    private claudeTokens: ClaudeSessionTokenService,
    private context: vscode.ExtensionContext
  ) {
    this.item = vscode.window.createStatusBarItem(
      "wat321.claudeForceAutoCompact",
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(4)
    );
    this.item.name = "WAT321: Claude Force Auto-Compact";
    this.item.command = COMMAND_ID;
    // Do not show() until first state delivered
  }

  update(state: ClaudeForceAutoCompactState): void {
    const prev = this.currentServiceState;
    this.currentServiceState = state;

    // Surface auto-disarm reasons as user-visible notifications so the
    // user knows *why* the widget went from armed back to ready when
    // they come back from a context switch.
    if (prev.status === "armed" && state.status === "restored") {
      const msg = formatDisarmMessage(this.service.lastDisarmReason);
      if (msg) vscode.window.showInformationMessage(msg);
      this.service.lastDisarmReason = null;
    }

    switch (state.status) {
      case "not-installed":
        this.item.hide();
        break;

      case "ready":
        this.item.text = `${CLAMP} Auto-Compact`;
        this.item.tooltip = buildReadyTooltip(this.liveTooltipInput());
        this.item.color = undefined;
        this.item.show();
        break;

      case "armed":
        this.item.text = `${RED_EXCLAM} Auto-Compact (Armed)`;
        this.item.tooltip = buildArmedTooltip();
        this.item.color = new vscode.ThemeColor("statusBarItem.errorForeground");
        this.item.show();
        break;

      case "restored":
        this.item.text = `${CLAMP} Auto-Compact (Restored)`;
        this.item.tooltip = "Auto-compact fired - CLAUDE_AUTOCOMPACT_PCT_OVERRIDE restored.";
        this.item.color = undefined;
        this.item.show();
        break;

      case "stale-sentinel":
        this.item.text = `${RED_EXCLAM} Auto-Compact (!)`;
        this.item.tooltip = buildStaleTooltip();
        this.item.color = new vscode.ThemeColor("statusBarItem.errorForeground");
        this.item.show();
        break;
    }
  }

  updateClaudeSession(state: ClaudeTokenState): void {
    if (state.status === "ok") {
      const s = state.session;
      this.currentClaudeSession = {
        sessionId: s.sessionId,
        label: s.label,
        sessionTitle: s.sessionTitle,
        contextUsed: s.contextUsed,
        contextWindowSize: s.contextWindowSize,
        autoCompactPct: s.autoCompactPct,
        source: s.source,
      };
    } else {
      this.currentClaudeSession = null;
    }
    if (this.currentServiceState.status !== "not-installed") {
      this.update(this.currentServiceState);
    }

    // Session-switch auto-disarm: only disarm when we can SEE a
    // different LIVE session in the workspace (user picked session B
    // in the extension picker). Transient flips to waiting/no-session/
    // lastKnown are deliberately NOT handled here - they would cause
    // spurious cancels during normal polling hiccups. The service's
    // own poll handles "target CLI actually exited" via the stronger
    // `isTargetSessionStillLive()` check every 2 seconds.
    if (this.currentServiceState.status === "armed") {
      const armedTarget = this.currentServiceState.sentinel.targetSessionId;
      const current = this.currentClaudeSession;
      if (
        current &&
        current.source === "live" &&
        current.sessionId !== armedTarget
      ) {
        this.service.disarm("session-switched");
      }
    }
  }

  private liveTooltipInput() {
    const c = this.currentClaudeSession;
    if (!c || c.source !== "live") return null;
    return {
      label: c.label,
      sessionTitle: c.sessionTitle,
      contextUsed: c.contextUsed,
      contextWindowSize: c.contextWindowSize,
      autoCompactPct: c.autoCompactPct,
    };
  }

  /** Command handler for the click / palette entry. */
  async onCommand(): Promise<void> {
    // Enforce consent before first use. We intentionally do NOT pass
    // `settingToRevert` - cancelling the consent dialog should not
    // uncheck the user's setting. They enabled it deliberately.
    if (!hasConsent(this.context, "claudeForceAutoCompact")) {
      const granted = await requestConsent(this.context, {
        toolKey: "claudeForceAutoCompact",
        title: "Claude Force Auto-Compact",
        body:
          "Claude Force Auto-Compact works by making a small, temporary change to " +
          "~/.claude/settings.json to run the built-in auto-compact on your next prompt. " +
          "Any files WAT321 changes are backed up first and restored automatically after " +
          "the auto-compact fires. This produces a higher-quality compaction result than " +
          "the /compact slash command.\n\n" +
          "This is the only WAT321 feature that writes outside ~/.wat321/. Reset WAT321 " +
          "clears this grant and restores anything WAT321 changed.\n\n" +
          "Grant consent to enable Claude Force Auto-Compact feature?",
        acceptLabel: "Grant Consent",
      });
      if (!granted) return;
    }

    const state = this.currentServiceState;
    if (state.status === "stale-sentinel") return this.handleStaleRestore();
    if (state.status === "armed") {
      // One-click disarm. Arming required an explicit confirm toast,
      // so an armed widget can only exist because the user deliberately
      // put it there moments ago. Disarming is a safe undo (restores
      // the original override, nothing is destroyed), so we do not
      // interpose a second toast - the "armed -> restored" state
      // flash + auto-disarm notification is sufficient feedback.
      this.service.disarm();
      return;
    }
    if (state.status === "ready") return this.handleReadyClick();
  }

  private async handleReadyClick(): Promise<void> {
    if (!this.currentClaudeSession) {
      vscode.window.showInformationMessage(
        "No active Claude session in this workspace to target. Send a prompt in Claude Code first."
      );
      return;
    }

    // Do not arm against a fallback (last-known) session. The widget
    // might be showing cached tokens from a closed session, in which
    // case there is no live CLI process to actually trigger the compact
    // on - lowering the global override would only affect whichever
    // Claude session the user opens next.
    if (this.currentClaudeSession.source !== "live") {
      vscode.window.showInformationMessage(
        "No live Claude session in this workspace. WAT321 is showing the last-known context from a closed session. Open Claude Code and send a prompt to establish a live session, then try again."
      );
      return;
    }

    const transcriptPath = this.claudeTokens.getActiveTranscriptPath();
    if (!transcriptPath) {
      vscode.window.showInformationMessage(
        "No transcript file resolved yet. Try again in a few seconds."
      );
      return;
    }

    const session = this.currentClaudeSession;
    const ceiling = Math.round(
      (session.autoCompactPct / 100) * session.contextWindowSize
    );
    const pct = ceiling > 0 ? Math.round((session.contextUsed / ceiling) * 100) : 0;

    const activeSessions = enumerateActiveClaudeSessions();
    const otherCount = activeSessions.filter(
      (s) => s.sessionId !== session.sessionId
    ).length;

    // Non-modal toast confirmation - same shape and behavior as the
    // one-time consent notification. Lives in the lower-right
    // notification area, does not block editor work, and does not
    // auto-commit on focus loss. A stray click anywhere outside the
    // toast does nothing; the only way to arm is to explicitly click
    // the "Arm Auto-Compact" button. Dismissing the toast via its X
    // returns undefined, which the guard below treats as cancel.
    const titlePrefix = session.sessionTitle
      ? `"${truncateTitle(session.sessionTitle)}" - `
      : "";
    const multiWarning =
      otherCount > 0
        ? ` ${otherCount} other Claude session${otherCount === 1 ? "" : "s"} detected; the override is global, so prompt in the target first.`
        : "";
    const message =
      `Arm Claude Force Auto-Compact for ${titlePrefix}${session.label} (${formatTokens(session.contextUsed)} / ${formatTokens(ceiling)}, ${formatPct(pct)})?` +
      multiWarning +
      " Your next prompt in Claude will trigger auto-compact. Override is restored automatically.";

    const choice = await vscode.window.showInformationMessage(
      message,
      "Arm Auto-Compact",
      "Cancel"
    );
    if (choice !== "Arm Auto-Compact") return;

    const result = this.service.arm(transcriptPath, session.sessionId, "1");
    if (!result.ok) {
      vscode.window.showErrorMessage(formatArmErrorMessage(result.reason));
      return;
    }

    vscode.window.showInformationMessage(
      "Claude Force Auto-Compact is armed. Send any prompt in the target Claude window now. " +
        "WAT321 will restore your override automatically after the compact fires."
    );
  }

  private async handleStaleRestore(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      "WAT321 found a leftover Claude Force Auto-Compact sentinel from a previous session. Retry restoring your original Claude setting?",
      "Retry Restore",
      "Dismiss"
    );
    if (choice === "Retry Restore") {
      const ok = this.service.retryStaleRestore();
      if (!ok) {
        vscode.window.showErrorMessage(
          "Restore failed again. Inspect ~/.wat321/claude-force-auto-compact-sentinel.json and ~/.claude/settings.json manually."
        );
      }
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

export function activateClaudeForceAutoCompactWidget(
  service: ClaudeForceAutoCompactService,
  claudeTokens: ClaudeSessionTokenService,
  context: vscode.ExtensionContext
): {
  disposables: vscode.Disposable[];
  widget: ClaudeForceAutoCompactWidget;
} {
  const widget = new ClaudeForceAutoCompactWidget(service, claudeTokens, context);

  const serviceListener = (state: ClaudeForceAutoCompactState) => widget.update(state);
  service.subscribe(serviceListener);

  const claudeListener = (state: ClaudeTokenState) => widget.updateClaudeSession(state);
  claudeTokens.subscribe(claudeListener);

  return {
    disposables: [
      widget,
      { dispose: () => service.unsubscribe(serviceListener) },
      { dispose: () => claudeTokens.unsubscribe(claudeListener) },
    ],
    widget,
  };
}

/**
 * Register the `wat321.claudeForceAutoCompact` command unconditionally
 * so the command palette entry always has a handler, even when the
 * feature is disabled. When disabled, the handler shows an info
 * message pointing to the setting. Called once during top-level
 * `activate()`.
 */
export function registerClaudeForceAutoCompactCommand(
  context: vscode.ExtensionContext,
  getActiveWidget: () => ClaudeForceAutoCompactWidget | null
): vscode.Disposable {
  const disposable = vscode.commands.registerCommand(COMMAND_ID, () => {
    const widget = getActiveWidget();
    if (!widget) {
      vscode.window.showInformationMessage(
        "Claude Force Auto-Compact is disabled. Enable 'WAT321: Enable Claude Force Auto-Compact' in settings to use this command."
      );
      return;
    }
    return widget.onCommand();
  });
  context.subscriptions.push(disposable);
  return disposable;
}
