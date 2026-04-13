import * as vscode from "vscode";
import { readdirSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ClaudeForceAutoCompactState, StatusBarWidget } from "./types";
import type { ClaudeForceAutoCompactService, DisarmReason } from "./service";
import type { ClaudeSessionTokenService } from "../WAT321_CLAUDE_SESSION_TOKENS/service";
import type { WidgetState as ClaudeTokenState } from "../WAT321_CLAUDE_SESSION_TOKENS/types";
import { getWidgetPriority } from "../shared/priority";
import { requestConsent, hasConsent } from "../shared/consent";
import { formatTokens, formatPct } from "../shared/ui/tokenFormatters";

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
      const reason = this.service.lastDisarmReason;
      const msg = this.formatDisarmMessage(reason);
      if (msg) vscode.window.showInformationMessage(msg);
      this.service.lastDisarmReason = null;
    }

    switch (state.status) {
      case "not-installed":
        this.item.hide();
        break;

      case "ready":
        {
          const live = this.currentClaudeSession?.source === "live" ? this.currentClaudeSession : null;
          if (live) {
            this.item.text = `${CLAMP} Auto-Compact ${formatTokens(live.contextUsed)}`;
          } else {
            this.item.text = `${CLAMP} Auto-Compact`;
          }
        }
        this.item.tooltip = this.buildReadyTooltip();
        this.item.color = undefined;
        this.item.show();
        break;

      case "armed": {
        const mins = Math.max(
          0,
          Math.round((Date.now() - state.sentinel.armedAt) / 60000)
        );
        this.item.text = `${RED_EXCLAM} Auto-Compact (Armed)`;
        this.item.tooltip = this.buildArmedTooltip(state.sentinel.targetSessionId, mins);
        this.item.color = new vscode.ThemeColor("statusBarItem.errorForeground");
        this.item.show();
        break;
      }

      case "restored":
        this.item.text = `${CLAMP} Auto-Compact (Restored)`;
        this.item.tooltip = "Auto-compact fired - CLAUDE_AUTOCOMPACT_PCT_OVERRIDE restored.";
        this.item.color = undefined;
        this.item.show();
        break;

      case "stale-sentinel":
        this.item.text = `${RED_EXCLAM} Auto-Compact (!)`;
        this.item.tooltip = this.buildStaleTooltip();
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
    // Refresh widget display so the new token count is reflected
    // immediately on the status bar (e.g. after a prompt completes).
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

  private formatDisarmMessage(reason: DisarmReason | null): string | null {
    switch (reason) {
      case "compact-detected":
        return "Auto-compact fired. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE restored.";
      case "timeout":
        return "Claude Force Auto-Compact timed out (5 min). CLAUDE_AUTOCOMPACT_PCT_OVERRIDE restored - no compact fired.";
      case "session-ended":
        return "Target Claude session ended before compact fired. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE restored.";
      case "session-switched":
        return "Claude session switched while Claude Force Auto-Compact was armed. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE restored.";
      default:
        return null;
    }
  }

  /** Command handler for the click / palette entry. */
  async onCommand(): Promise<void> {
    // Enforce consent before first use. We intentionally do NOT pass
    // `settingToRevert` - cancelling the consent dialog should not uncheck
    // the user's setting. They enabled it deliberately; they can simply
    // decline this one use and click again later when they are ready.
    if (!hasConsent(this.context, "claudeForceAutoCompact")) {
      const granted = await requestConsent(this.context, {
        toolKey: "claudeForceAutoCompact",
        title: "Claude Force Auto-Compact",
        body:
          "Claude Force Auto-Compact works by making a small, temporary change to " +
          "~/.claude/settings.json that tells Claude to run its built-in auto-compact on your " +
          "next prompt.\n\n" +
          "Any files WAT321 changes are backed up first and restored automatically after the " +
          "auto-compact fires.\n\n" +
          "This produces a higher-quality compaction result than the /compact slash command. " +
          "More of your conversation context, tool results, and reasoning is preserved in the " +
          "summary.\n\n" +
          "This is the only WAT321 feature that writes outside ~/.wat321/. Reset WAT321 clears " +
          "this grant and restores anything WAT321 changed.\n\n" +
          "Grant consent to enable Claude Force Auto-Compact?",
        acceptLabel: "Grant Consent",
      });
      if (!granted) return;
    }

    const state = this.currentServiceState;
    if (state.status === "stale-sentinel") {
      return this.handleStaleRestore();
    }
    if (state.status === "armed") {
      return this.handleArmedClick();
    }
    if (state.status === "ready") {
      return this.handleReadyClick();
    }
  }

  private async handleReadyClick(): Promise<void> {
    if (!this.currentClaudeSession) {
      vscode.window.showInformationMessage(
        "No active Claude session in this workspace to target. Send a prompt in Claude Code first."
      );
      return;
    }

    // Do not arm against a fallback (last-known) session. The widget might
    // be showing cached tokens from a closed session, in which case there
    // is no live CLI process to actually trigger the compact on - lowering
    // the global override would only affect whichever Claude session the
    // user opens next, which is the opposite of what they want.
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
    const ceiling = Math.round((session.autoCompactPct / 100) * session.contextWindowSize);
    const pct = ceiling > 0 ? Math.round((session.contextUsed / ceiling) * 100) : 0;

    const activeSessions = this.enumerateActiveClaudeSessions();
    const otherCount = activeSessions.filter((s) => s.sessionId !== session.sessionId).length;

    const titleLine = session.sessionTitle
      ? `"${this.truncateTitle(session.sessionTitle)}"  -  `
      : "";
    const multiWarning =
      otherCount > 0
        ? ` ${otherCount} other Claude session${otherCount === 1 ? "" : "s"} detected; the override is global, so prompt in the target first.`
        : "";
    const message =
      `Arm Claude Force Auto-Compact for ${titleLine}${session.label} (${formatTokens(session.contextUsed)} / ${formatTokens(ceiling)}, ${formatPct(pct)})?` +
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
      const msg = this.formatArmErrorMessage(result.reason);
      vscode.window.showErrorMessage(msg);
      return;
    }

    // Non-modal info notification to guide the user
    vscode.window.showInformationMessage(
      "Claude Force Auto-Compact is armed. Send any prompt in the target Claude window now. " +
      "WAT321 will restore your override automatically after the compact fires."
    );
  }

  private formatArmErrorMessage(reason: string): string {
    switch (reason) {
      case "sentinel-exists":
        return "A Claude Force Auto-Compact sentinel already exists at ~/.wat321/claude-force-auto-compact-sentinel.json. Another WAT321 instance may have armed it, or a previous run left it behind. Wait for the other instance, or check the file manually.";
      case "already-armed-value":
        return "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE is already set to 1 in ~/.claude/settings.json. WAT321 refuses to treat 1 as the original value. Restore your real override manually and try again.";
      case "settings-missing":
        return "~/.claude/settings.json does not exist. Claude Force Auto-Compact needs an existing Claude settings file to back up and restore.";
      default:
        return "Failed to arm Claude Force Auto-Compact. Check that ~/.claude/settings.json exists and is writable.";
    }
  }

  private async handleArmedClick(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      "Claude Force Auto-Compact is armed. Cancel and restore without triggering auto-compact?",
      "Cancel and Restore",
      "Leave Armed"
    );
    if (choice === "Cancel and Restore") {
      this.service.disarm();
    }
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

  /**
   * Scan ~/.claude/sessions/*.json for active Claude CLI processes and
   * return descriptors for the confirm dialog.
   */
  private enumerateActiveClaudeSessions(): Array<{ sessionId: string; cwd: string }> {
    const sessionsDir = join(homedir(), ".claude", "sessions");
    if (!existsSync(sessionsDir)) return [];

    const out: Array<{ sessionId: string; cwd: string }> = [];
    try {
      const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const raw = readFileSync(join(sessionsDir, file), "utf8");
          const entry = JSON.parse(raw) as { sessionId?: string; cwd?: string };
          if (entry.sessionId && entry.cwd) {
            out.push({ sessionId: entry.sessionId, cwd: entry.cwd });
          }
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
    return out;
  }

  private truncateTitle(raw: string): string {
    const maxTitleLen = 38;
    if (!raw) return "";
    return raw.length > maxTitleLen ? raw.slice(0, maxTitleLen) + "..." : raw;
  }

  private buildReadyTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = false;
    md.appendMarkdown("**Claude Force Auto-Compact**  \n");

    const live = this.currentClaudeSession?.source === "live" ? this.currentClaudeSession : null;

    if (live) {
      const title = this.truncateTitle(live.sessionTitle);
      if (title) {
        md.appendMarkdown(`"${title}"  \n`);
      }
      const ceiling = Math.round((live.autoCompactPct / 100) * live.contextWindowSize);
      const pct = ceiling > 0 ? Math.round((live.contextUsed / ceiling) * 100) : 0;
      md.appendMarkdown(
        `📁 ${live.label} ${formatTokens(live.contextUsed)} / ${formatTokens(ceiling)} (${formatPct(pct)})\n\n`
      );
      md.appendMarkdown("Click to trigger Claude's **auto-compact** on your next prompt.  \n");
      md.appendMarkdown("Higher-quality summary than `/compact` - Claude uses the main model and preserves tool results and reasoning.");
    } else {
      md.appendMarkdown("No live Claude session in this workspace.  \n\n");
      md.appendMarkdown("Open Claude Code and send a prompt to establish a live session, then click to arm.");
    }

    return md;
  }

  private buildArmedTooltip(targetSessionId: string, minsArmed: number): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = false;
    md.appendMarkdown("**Claude Force Auto-Compact - Armed**  \n");

    // Show the target session title + label if we still have them in the
    // widget state. The targetSessionId from the sentinel is the truth;
    // currentClaudeSession may have flipped during the armed window but
    // the title is informational so using the latest is acceptable.
    const current = this.currentClaudeSession;
    if (current && current.sessionId === targetSessionId) {
      const title = this.truncateTitle(current.sessionTitle);
      if (title) {
        md.appendMarkdown(`"${title}"  \n`);
      }
      md.appendMarkdown(`📁 ${current.label}  \n`);
    } else {
      md.appendMarkdown(`Target session: \`${targetSessionId.slice(0, 8)}\`  \n`);
    }
    md.appendMarkdown(`Armed ${minsArmed}m ago  \n\n`);
    md.appendMarkdown("Send any prompt in the target Claude window to trigger **auto-compact**.  \n");
    md.appendMarkdown("`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` will be restored automatically.  \n\n");
    md.appendMarkdown("Click to cancel and restore without triggering auto-compact.");
    return md;
  }

  private buildStaleTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = false;
    md.appendMarkdown("**Claude Force Auto-Compact - Needs Attention**  \n");
    md.appendMarkdown("A leftover sentinel from a previous session could not be restored automatically.  \n\n");
    md.appendMarkdown("Click to retry the restore.");
    return md;
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
 * Register the `wat321.claudeForceAutoCompact` command unconditionally so the
 * command palette entry always has a handler, even when the feature is
 * disabled. When disabled, the handler shows an info message pointing
 * to the setting. Called once during top-level `activate()`.
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
