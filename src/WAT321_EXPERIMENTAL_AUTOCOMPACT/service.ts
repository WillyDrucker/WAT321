import { existsSync, statSync } from "node:fs";
import * as vscode from "vscode";
import {
  readAutoCompactOverride,
  SETTINGS_PATH,
  writeAutoCompactOverride,
} from "../shared/claudeSettings";
import { getWidgetPriority, WIDGET_SLOT } from "../shared/priority";
import type { ClaudeSessionTokenService } from "../WAT321_CLAUDE_SESSION_TOKENS/service";
import type { WidgetState as ClaudeTokenWidgetState } from "../WAT321_CLAUDE_SESSION_TOKENS/types";
import {
  ARMED_OVERRIDE_VALUE,
  maybeCaptureInstallSnapshot,
  rotateArmBackup,
} from "./backups";
import { scanForCompactMarker } from "./compactDetector";
import { healStuckOverride, safeRestoreValue, type HealResult } from "./heal";
import {
  determineArmBlocker,
  formatArmBlockerMessage,
} from "./preflightGate";
import { deleteSentinel, SENTINEL_PATH, writeSentinel } from "./sentinel";
import type {
  ActiveContextInfo,
  ExperimentalAutoCompactSentinel,
} from "./types";

/**
 * Experimental Force Claude Auto-Compact service. Driven by the
 * `wat321.experimental.forceClaudeAutoCompact` checkbox:
 *
 *   - Ticking the box runs a preflight gate, shows a confirmation
 *     dialog if the gate passes, and arms on confirm. The box stays
 *     ticked while armed. If the gate blocks or the user cancels
 *     the dialog, the box is unticked immediately.
 *
 *   - Unticking the box while armed disarms silently (user-cancel).
 *
 *   - On compact detection or 30s timeout, the service disarms,
 *     restores the override, disposes the armed status bar item,
 *     and unticks the box.
 *
 *   - Clicking the red `! ARMED` status bar item disarms the same
 *     way as unticking.
 *
 * Safety contracts:
 *   - Sentinel + 3-slot arm backup ring + install snapshot +
 *     hardcoded `"85"` form a four-tier restore precedence chain,
 *     poison-checked at every tier against the armed value `"1"`.
 *   - `healStuckOverride()` on startup unsticks any override left
 *     stuck by a crash in a previous session.
 *   - On activation, the setting is force-reset to `false` so a
 *     `true` value left across a VS Code restart never auto-arms.
 *   - `dispose()` runs a synchronous best-effort restore before
 *     clearing timers and listeners so a mid-arm provider teardown
 *     still unsticks the override.
 */

const SETTING_KEY = "experimental.forceClaudeAutoCompact";
const FULL_SETTING_PATH = `wat321.${SETTING_KEY}`;

/** Window in which the tool waits for a compact marker after arming. */
const ARM_WINDOW_MS = 30_000;

/** Post-disarm cooldown during which re-arming is refused. */
const COOLDOWN_MS = 30_000;

/** Poll cadence while armed. */
const POLL_INTERVAL_MS = 2_000;

/** Glyph prefix on the armed status bar item. Plain ASCII exclamation
 * so the theme color (`statusBarItem.errorForeground`) paints the
 * whole text uniformly red. The emoji form (U+2757) renders as its
 * own multi-color glyph and clashes with the text portion. */
const RED_EXCLAIM = "!";

type DisarmReason = "user-cancel" | "compact-detected" | "timeout";

export class ExperimentalAutoCompactService {
  private armedSentinel: ExperimentalAutoCompactSentinel | null = null;
  private armedScanOffset = 0;
  private cooldownUntil = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private configListener: vscode.Disposable | null = null;
  private tokenListener: ((state: ClaudeTokenWidgetState) => void) | null = null;
  private armedItem: vscode.StatusBarItem | null = null;
  private disposed = false;
  /** Cached live context snapshot from the Claude session token
   * service. Drives the preflight gate's context-fraction and
   * transcript-path needs. `null` when no live Claude session is
   * currently resolved. */
  private activeContext: ActiveContextInfo | null = null;

  constructor(private tokenService: ClaudeSessionTokenService) {}

  start(): void {
    // Startup failsafe: heal any override stuck at "1" from a prior
    // session, before wiring up any listeners.
    let healResult: HealResult = "not-stuck";
    try {
      healResult = healStuckOverride();
    } catch {
      healResult = "io-error";
    }
    if (
      healResult === "restored-from-sentinel" ||
      healResult === "restored-from-arm-backup" ||
      healResult === "restored-from-install-snapshot" ||
      healResult === "restored-to-default"
    ) {
      vscode.window.showInformationMessage(
        "WAT321 restored your Claude auto-compact setting from a previous session."
      );
    }

    maybeCaptureInstallSnapshot();

    // Force the setting to false on activate regardless of its prior
    // state. A `true` value left across restart would otherwise run
    // the preflight gate immediately on startup, which is surprising.
    // Silent - the user will see the checkbox unchecked next time
    // they open settings.
    const current = vscode.workspace
      .getConfiguration("wat321")
      .get<boolean>(SETTING_KEY, false);
    if (current) {
      void this.resetSetting();
    }

    // Subscribe to the Claude session token service so the preflight
    // gate always has a live context snapshot + transcript path.
    // Updates land on every session token poll (~5 s cadence).
    this.tokenListener = (state: ClaudeTokenWidgetState) => {
      this.applyTokenState(state);
    };
    this.tokenService.subscribe(this.tokenListener);

    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(FULL_SETTING_PATH)) return;
      const enabled = vscode.workspace
        .getConfiguration("wat321")
        .get<boolean>(SETTING_KEY, false);
      // Idempotent: act only when the setting and our internal
      // armed state disagree. Our own writes land here too and
      // no-op automatically because they always match our state.
      if (enabled && !this.armedSentinel) {
        void this.tryArm();
      } else if (!enabled && this.armedSentinel) {
        void this.confirmUserDisarm();
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // If we are armed at dispose time, restore the override
    // synchronously before tearing down. Covers Claude provider
    // disabled mid-arm, VS Code closing mid-arm, or any other
    // teardown while a cycle is still in flight.
    if (this.armedSentinel && existsSync(SENTINEL_PATH)) {
      const target = safeRestoreValue(this.armedSentinel.originalOverride);
      if (writeAutoCompactOverride(target)) {
        deleteSentinel();
      }
      this.armedSentinel = null;
    }

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.configListener) {
      this.configListener.dispose();
      this.configListener = null;
    }
    if (this.tokenListener) {
      this.tokenService.unsubscribe(this.tokenListener);
      this.tokenListener = null;
    }
    if (this.armedItem) {
      this.armedItem.dispose();
      this.armedItem = null;
    }
  }

  /** Exposed for the Reset WAT321 path so it can heal a stuck override
   * without holding a reference to service internals. */
  static healStuckOverride(): HealResult {
    return healStuckOverride();
  }

  /** Translate a Claude session token state update into the live
   * context snapshot the preflight gate consumes. Only `ok` states
   * with a `live` source yield a usable `ActiveContextInfo` - the
   * `lastKnown` fallback represents a session with no live CLI
   * process, which has no transcript to arm against. */
  private applyTokenState(state: ClaudeTokenWidgetState): void {
    if (state.status !== "ok" || state.session.source !== "live") {
      this.activeContext = null;
      return;
    }
    const session = state.session;
    const transcriptPath = this.tokenService.getActiveTranscriptPath();
    if (!transcriptPath) {
      this.activeContext = null;
      return;
    }
    const ceiling = Math.round(
      (session.autoCompactPct / 100) * session.contextWindowSize
    );
    if (ceiling <= 0) {
      this.activeContext = null;
      return;
    }
    this.activeContext = {
      transcriptPath,
      contextUsed: session.contextUsed,
      ceiling,
      fraction: session.contextUsed / ceiling,
    };
  }

  private async tryArm(): Promise<void> {
    // Preflight gate: refuse arm with a friendly error toast if any
    // blocker is active. On rejection, uncheck the box and bail -
    // the user should never see a confirmation dialog for an arm
    // that is going to fail.
    const blocker = determineArmBlocker({
      activeContext: this.activeContext,
      cooldownUntil: this.cooldownUntil,
    });
    if (blocker !== null) {
      const cooldownRemaining = Math.max(0, this.cooldownUntil - Date.now());
      vscode.window.showWarningMessage(
        formatArmBlockerMessage(blocker, this.activeContext, cooldownRemaining)
      );
      void this.resetSetting();
      return;
    }

    // Confirmation dialog. Non-modal so it follows the user's
    // preference for bottom-right notification placement. X-close
    // on the notification returns undefined, which we treat the
    // same as explicit Cancel (un-tick the checkbox and bail).
    const choice = await vscode.window.showInformationMessage(
      "Arm Claude Auto-Compact for your next message to Claude? Your next prompt will trigger Claude's built-in auto-compact. Disarms after 30 seconds of no activity.",
      "Arm Auto-Compact",
      "Cancel"
    );
    if (choice !== "Arm Auto-Compact") {
      await this.resetSetting();
      return;
    }

    // Race guard: the dialog is non-modal, so the user could untick
    // the checkbox while it is open. Re-read the setting before we
    // commit any writes. If the user already unticked, bail silently.
    const stillEnabled = vscode.workspace
      .getConfiguration("wat321")
      .get<boolean>(SETTING_KEY, false);
    if (!stillEnabled) return;

    // Another guard: the service may have been disposed while the
    // dialog was open.
    if (this.disposed) return;

    this.arm();
  }

  private arm(): void {
    if (this.armedSentinel) return;

    const ctx = this.activeContext;
    if (!ctx) {
      // Active context went stale between preflight and arm. Show a
      // brief error and bail.
      vscode.window.showWarningMessage(
        "WAT321 lost sight of your active Claude session. Try again in a moment."
      );
      void this.resetSetting();
      return;
    }

    const read = readAutoCompactOverride();
    if (read.kind !== "present") {
      vscode.window.showWarningMessage(
        "WAT321 lost access to ~/.claude/settings.json. Try again in a moment."
      );
      void this.resetSetting();
      return;
    }
    const originalOverride = read.value;
    if (originalOverride === ARMED_OVERRIDE_VALUE) {
      vscode.window.showWarningMessage(
        "Your Claude auto-compact override is already set to 1. WAT321 will heal this on the next VS Code start. Run WAT321: Reset All Settings if you need to unstick it now."
      );
      void this.resetSetting();
      return;
    }

    let baselineSize = 0;
    try {
      baselineSize = statSync(ctx.transcriptPath).size;
    } catch {
      vscode.window.showWarningMessage(
        "WAT321 could not read the Claude transcript file. Try again in a moment."
      );
      void this.resetSetting();
      return;
    }

    // Rotate backup ring BEFORE sentinel so even a sentinel-write
    // failure leaves the user's original value on disk.
    rotateArmBackup(originalOverride);

    const sentinel: ExperimentalAutoCompactSentinel = {
      version: 1,
      settingsPath: SETTINGS_PATH,
      originalOverride,
      armedOverride: ARMED_OVERRIDE_VALUE,
      watchTranscriptPath: ctx.transcriptPath,
      baselineSize,
      armedAt: Date.now(),
    };

    if (!writeSentinel(sentinel)) {
      vscode.window.showWarningMessage(
        "WAT321 could not save its arm record. Check disk space and file permissions, then try again."
      );
      void this.resetSetting();
      return;
    }

    if (!writeAutoCompactOverride(ARMED_OVERRIDE_VALUE)) {
      deleteSentinel();
      vscode.window.showWarningMessage(
        "WAT321 could not update ~/.claude/settings.json. Check that the file is not locked or read-only, then try again."
      );
      void this.resetSetting();
      return;
    }

    this.armedSentinel = sentinel;
    this.armedScanOffset = baselineSize;
    this.showArmedItem();

    vscode.window.showInformationMessage(
      "Claude Auto-Compact armed. Next prompt will trigger Auto-Compact."
    );

    this.schedulePoll();
  }

  private disarm(reason: DisarmReason): void {
    const sentinel = this.armedSentinel;
    if (!sentinel) return;

    if (existsSync(SENTINEL_PATH)) {
      const target = safeRestoreValue(sentinel.originalOverride);
      if (!writeAutoCompactOverride(target)) {
        vscode.window.showErrorMessage(
          "WAT321 could not restore your Claude settings. Run WAT321: Reset All Settings to unstick."
        );
        return;
      }
      deleteSentinel();
    }

    this.armedSentinel = null;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.disposeArmedItem();

    if (reason === "compact-detected" || reason === "timeout") {
      this.cooldownUntil = Date.now() + COOLDOWN_MS;
    }

    // Flip the checkbox off to reflect the disarmed state. Our
    // config listener short-circuits because armedSentinel is null.
    void this.resetSetting();

    if (reason === "compact-detected") {
      vscode.window.showInformationMessage(
        "Auto-compact fired. Your Claude settings have been restored."
      );
    } else if (reason === "timeout") {
      vscode.window.showInformationMessage(
        "Claude Auto-Compact disarmed. Timed out after 30 seconds."
      );
    }
    // user-cancel is silent - the user clicked the checkbox or the
    // armed widget and already knows what they did.
  }

  /** Create and show the red `! ARMED` status bar item. Idempotent:
   * calling twice in a row is a no-op. Tooltip is a MarkdownString
   * so the leading exclaim can render red via the emoji glyph and
   * the `Click to disarm.` line can render in bold. `isTrusted`
   * stays false - the tooltip contains no commands. */
  private showArmedItem(): void {
    if (this.armedItem) return;
    const item = vscode.window.createStatusBarItem(
      "wat321.claudeAutoCompactArmed",
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(WIDGET_SLOT.claudeAutoCompactArmed)
    );
    item.name = "WAT321: Claude Auto-Compact (Armed)";
    item.text = `${RED_EXCLAIM} ARMED`;
    item.color = new vscode.ThemeColor("statusBarItem.errorForeground");
    const tooltip = new vscode.MarkdownString();
    tooltip.isTrusted = false;
    tooltip.supportThemeIcons = true;
    tooltip.appendMarkdown("\u2757 Claude Auto-Compact - Armed\n\n**Click to disarm.**");
    item.tooltip = tooltip;
    item.command = CANCEL_COMMAND_ID;
    item.show();
    this.armedItem = item;
  }

  private disposeArmedItem(): void {
    if (!this.armedItem) return;
    this.armedItem.dispose();
    this.armedItem = null;
  }

  /** Command handler for the armed status bar item's click. Wired
   * in `registerCancelCommand` below. */
  cancelFromWidget(): void {
    if (!this.armedSentinel) return;
    this.disarm("user-cancel");
  }

  /** Flip the experimental checkbox off at every applicable scope.
   * Writing at Global alone is not enough: if the user happened to
   * toggle the setting from the Workspace tab of the Settings UI (or
   * via a `.vscode/settings.json` override), a Global-only write
   * leaves the effective value stuck at `true` because workspace
   * wins over global. Same three-scope discipline as Reset WAT321
   * uses in `src/shared/clearSettings.ts`.
   *
   * Writes `undefined` to remove the user-set value entirely rather
   * than writing an explicit `false`, so we revert to the schema
   * default without polluting settings files with scope rows the
   * user never actively set. */
  private async resetSetting(): Promise<void> {
    await this.writeSettingAllScopes(undefined);
  }

  /** Re-tick the checkbox at every applicable scope. Used after the
   * user cancels the disarm confirmation dialog, to keep the visible
   * checkbox state in sync with the internal armed state. */
  private async restoreSettingToTrue(): Promise<void> {
    await this.writeSettingAllScopes(true);
  }

  private async writeSettingAllScopes(value: boolean | undefined): Promise<void> {
    const config = vscode.workspace.getConfiguration("wat321");
    const hasWorkspace =
      (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    const targets: vscode.ConfigurationTarget[] = [
      vscode.ConfigurationTarget.Global,
    ];
    if (hasWorkspace) {
      targets.push(
        vscode.ConfigurationTarget.Workspace,
        vscode.ConfigurationTarget.WorkspaceFolder
      );
    }
    await Promise.all(
      targets.map(async (scope) => {
        try {
          await config.update(SETTING_KEY, value, scope);
        } catch {
          // Scope applicable but update rejected (read-only, etc.).
        }
      })
    );
  }

  /** Pop a confirmation dialog when the user unchecks the box while
   * armed. On confirm, disarm. On cancel (including X-out of the
   * notification), re-tick the box so the visible state stays in
   * sync with the still-armed internal state.
   *
   * Carefully handles the race where the 30-second timeout OR a
   * compact detection fires while the dialog is still open: if we
   * are no longer armed by the time the dialog resolves, no
   * re-tick is needed because the automatic disarm path has
   * already unticked the box for us. */
  private async confirmUserDisarm(): Promise<void> {
    if (!this.armedSentinel) return;

    const choice = await vscode.window.showInformationMessage(
      "Disarm Claude Auto-Compact? Your Claude settings will be restored.",
      "Disarm",
      "Cancel"
    );

    if (this.disposed) return;

    if (choice === "Disarm") {
      if (this.armedSentinel) this.disarm("user-cancel");
      return;
    }

    // Cancel / X / dismiss. Only re-tick if we are still armed -
    // the auto-disarm path may have fired during the dialog and
    // already unticked the box.
    if (this.armedSentinel) {
      await this.restoreSettingToTrue();
    }
  }

  private schedulePoll(): void {
    if (this.disposed || !this.armedSentinel) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (this.disposed) return;
      this.poll();
      if (!this.disposed && this.armedSentinel && this.pollTimer === null) {
        this.schedulePoll();
      }
    }, POLL_INTERVAL_MS);
  }

  private poll(): void {
    if (!this.armedSentinel) return;
    const sentinel = this.armedSentinel;

    // External disarm: sentinel file gone (another VS Code window or
    // Reset WAT321 already cleaned up).
    if (!existsSync(SENTINEL_PATH)) {
      this.armedSentinel = null;
      this.disposeArmedItem();
      void this.resetSetting();
      return;
    }

    // Timeout failsafe: restore even if compact never fired.
    if (Date.now() - sentinel.armedAt > ARM_WINDOW_MS) {
      this.disarm("timeout");
      return;
    }

    try {
      const size = statSync(sentinel.watchTranscriptPath).size;
      const outcome = scanForCompactMarker(
        sentinel.watchTranscriptPath,
        this.armedScanOffset,
        size
      );
      this.armedScanOffset = outcome.nextOffset;
      if (outcome.found) {
        this.disarm("compact-detected");
      }
    } catch {
      // Transcript may have been replaced mid-compact.
      if (!existsSync(sentinel.watchTranscriptPath)) {
        this.disarm("compact-detected");
      }
    }
  }
}

/** Internal command id for the armed status bar item's click
 * target. NOT listed in `package.json contributes.commands` so it
 * never appears in the palette - it exists only as a click target
 * on the armed widget. */
export const CANCEL_COMMAND_ID = "wat321.cancelExperimentalAutoCompact";

/** Register the click-to-disarm command for the armed status bar
 * item. Called once during top-level `activate()` with a resolver
 * that returns the currently-active service instance (or null when
 * the Claude provider group is not active). */
export function registerCancelExperimentalAutoCompactCommand(
  context: vscode.ExtensionContext,
  getActiveService: () => ExperimentalAutoCompactService | null
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CANCEL_COMMAND_ID, () => {
      getActiveService()?.cancelFromWidget();
    })
  );
}
