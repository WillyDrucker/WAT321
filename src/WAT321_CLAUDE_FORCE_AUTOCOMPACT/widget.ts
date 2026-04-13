import * as vscode from "vscode";
import type { ClaudeForceAutoCompactState, StatusBarWidget } from "./types";
import type {
  ClaudeForceAutoCompactService,
  CooldownEvent,
} from "./service";
import type { ClaudeSessionTokenService } from "../WAT321_CLAUDE_SESSION_TOKENS/service";
import type { WidgetState as ClaudeTokenState } from "../WAT321_CLAUDE_SESSION_TOKENS/types";
import { getWidgetPriority } from "../shared/priority";
import { hasConsent, requestConsent } from "../shared/consent";
import { formatPct, formatTokens } from "../shared/ui/tokenFormatters";
import { enumerateActiveClaudeSessions } from "./activeClaudeSessions";
import { formatDisarmMessage } from "./messages";
import {
  buildArmedTooltip,
  buildReadyTooltip,
  buildStaleTooltip,
  buildUnavailableTooltip,
  truncateTitle,
} from "./tooltips";
import {
  buildArmConfirmHints,
  type ActiveContextInfo,
} from "./preflightGate";

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
        this.item.command = COMMAND_ID;
        this.item.show();
        break;

      case "armed":
        this.item.text = `${RED_EXCLAM} Auto-Compact (Armed)`;
        this.item.tooltip = buildArmedTooltip();
        this.item.color = new vscode.ThemeColor("statusBarItem.errorForeground");
        this.item.command = COMMAND_ID;
        this.item.show();
        break;

      case "restored":
        this.item.text = `${CLAMP} Auto-Compact (Restored)`;
        this.item.tooltip = "Auto-compact fired - CLAUDE_AUTOCOMPACT_PCT_OVERRIDE restored.";
        this.item.color = undefined;
        this.item.command = COMMAND_ID;
        this.item.show();
        break;

      case "stale-sentinel":
        this.item.text = `${RED_EXCLAM} Auto-Compact (!)`;
        this.item.tooltip = buildStaleTooltip();
        this.item.color = new vscode.ThemeColor("statusBarItem.errorForeground");
        this.item.command = COMMAND_ID;
        this.item.show();
        break;

      case "unavailable":
        // Grayed. RED is deliberately NOT used here so the armed
        // state stays visually distinct. Click behavior depends on
        // whether WAT321 can actually repair the underlying issue:
        //
        //   - `settings-stuck-at-armed` and `settings-io-error`:
        //     clickable to force an immediate repair attempt
        //     (bypassing the 5 min auto-heal cooldown). Tooltip
        //     reflects "click to retry".
        //
        //   - Every other reason (auto-clearing, not our loop,
        //     not our settings, another instance owns it): hover
        //     only, command unset. Tooltip explains the reason.
        this.item.text = `${CLAMP} Auto-Compact`;
        this.item.tooltip = buildUnavailableTooltip(
          state.reason,
          this.unavailableTooltipContext()
        );
        this.item.color = new vscode.ThemeColor("disabledForeground");
        if (
          state.reason === "settings-stuck-at-armed" ||
          state.reason === "settings-io-error"
        ) {
          this.item.command = COMMAND_ID;
        } else {
          this.item.command = undefined;
        }
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

    // Feed the service's primary arm gate: current live-session
    // context info, including the `contextUsed / ceiling` fraction
    // that drives the `below-useful-threshold` rule. Pass `null`
    // when there is no live session. The service caches this and
    // uses it for every subsequent resolve until the next update.
    let activeContext: ActiveContextInfo | null = null;
    if (state.status === "ok" && state.session.source === "live") {
      const s = state.session;
      const transcriptPath = this.claudeTokens.getActiveTranscriptPath();
      const ceiling = Math.round(
        (s.autoCompactPct / 100) * s.contextWindowSize
      );
      if (transcriptPath && ceiling > 0) {
        activeContext = {
          transcriptPath,
          contextUsed: s.contextUsed,
          ceiling,
          fraction: s.contextUsed / ceiling,
        };
      }
    }
    this.service.setActiveContext(activeContext);

    // Free piggyback: every Claude session token service update
    // (~5 s cadence) is a signal that the session state may have
    // moved. Snap-check the availability so the widget reflects
    // the new context fraction without waiting for the idle poll.
    if (activeContext) {
      this.service.snapCheckAvailability();
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

  /** Build the context input for the unavailable tooltip so the
   * `below-useful-threshold` variant can show the user exactly
   * where they are against the activation and native thresholds.
   * Returns null when no live session is available, in which case
   * the tooltip falls back to a generic explanation. */
  private unavailableTooltipContext() {
    const c = this.currentClaudeSession;
    if (!c || c.source !== "live") return null;
    const ceiling = Math.round((c.autoCompactPct / 100) * c.contextWindowSize);
    if (ceiling <= 0) return null;
    return {
      contextUsed: c.contextUsed,
      ceiling,
      fraction: c.contextUsed / ceiling,
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
          "Claude Force Auto-Compact temporarily edits ~/.claude/settings.json " +
          "so your next prompt in Claude triggers the built-in auto-compact. " +
          "WAT321 backs up your settings first and restores them automatically " +
          "after the compact fires. This is the only WAT321 feature that writes " +
          "outside ~/.wat321/. Reset WAT321 clears this grant. " +
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
    if (state.status === "unavailable") {
      // Only the two clickable-repair reasons reach this handler -
      // the widget unsets `item.command` for all other reasons so
      // the click never fires. We still guard defensively here.
      if (
        state.reason !== "settings-stuck-at-armed" &&
        state.reason !== "settings-io-error"
      ) {
        return;
      }
      return this.handleRepairClick();
    }
    if (state.status === "ready") return this.handleReadyClick();
  }

  /** Explicit user click on a clickable-repair unavailable state.
   * Calls `service.manualRepair` which bypasses the auto-heal
   * retry cooldown, then surfaces an info or warning toast based
   * on whether the repair cleared the underlying condition. */
  private async handleRepairClick(): Promise<void> {
    // Repair does not need a live Claude session. The underlying
    // path is `healStuckOverride()` which is settings-driven. The
    // service already has whatever context info is cached from the
    // most recent session token update, and `manualRepair` bypasses
    // the context gate entirely (user explicit action on a stuck
    // state should fix it regardless of current context).
    const result = this.service.manualRepair();
    if (result === null) {
      vscode.window.showInformationMessage(
        "Claude Force Auto-Compact repaired. Your CLAUDE_AUTOCOMPACT_PCT_OVERRIDE is back to a safe value."
      );
      return;
    }
    // Repair did not fully clear the issue. Escalate to the manual
    // reset path without yelling.
    vscode.window.showWarningMessage(
      "WAT321 could not fully repair the state. Try WAT321: Reset All Settings in settings."
    );
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
        "Session detection is still catching up. Try again in a moment."
      );
      return;
    }

    // Click-time snap check. The passive poll runs every 15 s in
    // the idle safety net path, which means the widget could be
    // showing `ready` even though something changed a moment ago.
    // Re-evaluate availability against the latest cached state so
    // the user's click either transitions into a grayed state
    // (and we return silently; widget.update handles the visuals)
    // or proceeds to the confirm dialog on a confirmed-clean state.
    const snapReason = this.service.snapCheckAvailability();
    if (snapReason !== null) return;

    const session = this.currentClaudeSession;
    const ceiling = Math.round(
      (session.autoCompactPct / 100) * session.contextWindowSize
    );
    const pct = ceiling > 0 ? Math.round((session.contextUsed / ceiling) * 100) : 0;
    const contextFractionOfCeiling =
      ceiling > 0 ? session.contextUsed / ceiling : 0;

    const activeSessions = enumerateActiveClaudeSessions();
    const otherCount = activeSessions.filter(
      (s) => s.sessionId !== session.sessionId
    ).length;

    // The widget's grayed `unavailable` state already prevents the
    // click from reaching this code path when the tool is paused,
    // so we do NOT run the availability resolver again here -
    // `arm()` itself re-runs it as defense in depth. The only thing
    // the widget still needs from preflight is the confirm-dialog
    // hints (context near threshold, other live sessions).
    const hints = buildArmConfirmHints({
      contextFractionOfCeiling,
      otherLiveSessionCount: otherCount,
    });

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
    const baseLine = `Arm Claude Force Auto-Compact for ${titlePrefix}${session.label} (${formatTokens(session.contextUsed)} / ${formatTokens(ceiling)}, ${formatPct(pct)})? Your next prompt in Claude will trigger auto-compact. Override is restored automatically.`;

    // Confirm-dialog hints are appended inline so the user sees
    // "near native threshold" and "other live sessions" warnings
    // in one place.
    const hintLines = hints.map((h) => h.text).join(" ");
    const message = hintLines ? `${baseLine} ${hintLines}` : baseLine;

    const choice = await vscode.window.showInformationMessage(
      message,
      "Arm Auto-Compact",
      "Cancel"
    );
    if (choice !== "Arm Auto-Compact") return;

    const result = this.service.arm(transcriptPath, session.sessionId, "1");
    if (!result.ok) {
      vscode.window.showWarningMessage(result.message);
      return;
    }

    vscode.window.showInformationMessage(
      "Claude Force Auto-Compact is armed. Send any prompt in the target Claude window now. " +
        "WAT321 will restore your override automatically after the compact fires."
    );
  }

  /** Handle post-disarm cooldown events from the service. The
   * `loop-detected` event fires when the Claude CLI is still firing
   * compacts after WAT321 has already restored the override value;
   * the typical cause is the CLI having cached the old env var at
   * process start. Surface a plain-English warning telling the user
   * to restart their Claude terminal. Other cooldown events are
   * internal state transitions and do not need user-visible output. */
  onCooldownEvent(event: CooldownEvent): void {
    if (event.kind === "loop-detected") {
      vscode.window.showWarningMessage(
        "Claude is still firing auto-compacts after WAT321 restored your setting. Close and reopen the Claude terminal to pick up the restored value."
      );
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
        vscode.window.showWarningMessage(
          "WAT321 could not automatically restore your Claude setting. Run **WAT321: Reset All Settings** in the command palette to return to a clean state."
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

  const cooldownListener = (event: CooldownEvent) => widget.onCooldownEvent(event);
  service.subscribeCooldown(cooldownListener);

  return {
    disposables: [
      widget,
      { dispose: () => service.unsubscribe(serviceListener) },
      { dispose: () => claudeTokens.unsubscribe(claudeListener) },
      { dispose: () => service.unsubscribeCooldown(cooldownListener) },
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
