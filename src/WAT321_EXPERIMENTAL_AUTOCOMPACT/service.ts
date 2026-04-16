import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import * as vscode from "vscode";
import {
  readAutoCompactOverride,
  SETTINGS_PATH,
  writeAutoCompactOverride,
} from "../shared/claudeSettings";
import { clearCheckboxSetting } from "../shared/clearSettings";
import { SETTING } from "../engine/settingsKeys";
import type { ClaudeSessionTokenService } from "../WAT321_CLAUDE_SESSION_TOKENS/service";
import type { WidgetState as ClaudeTokenWidgetState } from "../WAT321_CLAUDE_SESSION_TOKENS/types";
import { ArmedStatusBarItem, CANCEL_COMMAND_ID } from "./armedStatusBarItem";
import { ARMED_OVERRIDE_VALUE } from "./constants";
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
 *   - Unticking the box while armed disarms immediately, restores
 *     the override, disposes the armed widget, and surfaces a
 *     `Claude Auto-Compact Disarmed. Cancelled.` toast.
 *
 *   - Clicking the red `! ARMED` status bar item disarms the same
 *     way as unticking.
 *
 *   - The moment a prompt lands in the transcript, the override is
 *     restored immediately and the service fully disarms (sentinel
 *     cleanup, cooldown, checkbox untick). Claude reads the override
 *     at prompt time and commits to its compact decision; restoring
 *     afterward does not undo the compact but prevents any loop.
 *     The calculated threshold (currentPct - 5) is the primary loop
 *     prevention; the instant restore is belt-and-suspenders.
 *
 * Safety contracts:
 *   - Sentinel records the user's original override (custom string
 *     or `null` for "key absent"). On disarm or heal, sentinel
 *     value is restored; if sentinel is missing, the key is deleted
 *     so Claude falls back to its own built-in default formula.
 *     The legacy armed value `"1"` is poison-checked and never
 *     restored.
 *   - `healStuckOverride()` on startup unsticks any override left
 *     stuck by a crash (checks both legacy "1" and the sentinel's
 *     recorded dynamic armed value).
 *   - On activation, the setting is force-reset to `false` so a
 *     `true` value left across a VS Code restart never auto-arms.
 *   - `dispose()` runs a synchronous best-effort restore before
 *     clearing timers and listeners so a mid-arm provider teardown
 *     still unsticks the override.
 */

const SETTING_KEY = SETTING.experimentalAutoCompact;
const FULL_SETTING_PATH = `wat321.${SETTING_KEY}`;

/** Window in which the tool waits for a prompt after arming. If the
 * user never types, we time out and disarm loudly. */
const ARM_WINDOW_MS = 30_000;

/** Post-disarm cooldown during which re-arming is refused. */
const COOLDOWN_MS = 30_000;

type DisarmReason = "user-cancel" | "prompt-detected" | "timeout";

export class ExperimentalAutoCompactService {
  private armedSentinel: ExperimentalAutoCompactSentinel | null = null;
  private cooldownUntil = 0;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptWatcher: FSWatcher | null = null;
  private configListener: vscode.Disposable | null = null;
  private tokenListener: ((state: ClaudeTokenWidgetState) => void) | null = null;
  private armedItem = new ArmedStatusBarItem();
  private disposed = false;
  /** Cached live context snapshot from the Claude session token
   * service. Drives the preflight gate's context-fraction and
   * transcript-path needs. `null` when no live Claude session is
   * currently resolved. */
  private activeContext: ActiveContextInfo | null = null;

  constructor(private tokenService: ClaudeSessionTokenService) {}

  start(): void {
    // Startup failsafe: heal any override stuck from a prior
    // session, before wiring up any listeners.
    let healResult: HealResult = "not-stuck";
    try {
      healResult = healStuckOverride();
    } catch {
      healResult = "io-error";
    }
    if (
      healResult === "restored-from-sentinel" ||
      healResult === "restored-to-default"
    ) {
      vscode.window.showInformationMessage(
        "WAT321 restored your Claude auto-compact setting from a previous session."
      );
    }

    // Force the setting to false on activate regardless of its prior
    // state. A `true` value left across restart would otherwise run
    // the preflight gate immediately on startup, which is surprising.
    // Silent - the user will see the checkbox unchecked next time
    // they open settings.
    const current = vscode.workspace
      .getConfiguration("wat321")
      .get<boolean>(SETTING_KEY, false);
    if (current) {
      void clearCheckboxSetting(SETTING_KEY);
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
        // Unticking the box while armed disarms immediately and
        // silently - the user already knows what they just did, so
        // an extra confirm dialog would be friction, not safety.
        this.disarm("user-cancel");
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

    this.closeTranscriptWatcher();
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.configListener) {
      this.configListener.dispose();
      this.configListener = null;
    }
    if (this.tokenListener) {
      this.tokenService.unsubscribe(this.tokenListener);
      this.tokenListener = null;
    }
    this.armedItem.dispose();
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
      contextWindowSize: session.contextWindowSize,
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
      void clearCheckboxSetting(SETTING_KEY);
      return;
    }

    // Confirmation dialog. Non-modal so it follows the user's
    // preference for bottom-right notification placement. X-close
    // on the notification returns undefined, which we treat the
    // same as explicit Cancel (un-tick the checkbox and bail).
    const choice = await vscode.window.showInformationMessage(
      "Arm Claude Auto-Compact for your next message to Claude? Your next prompt will trigger Claude's built-in auto-compact. Disarms automatically once your prompt lands, or after 30 seconds if no prompt is sent.",
      "Arm Auto-Compact",
      "Cancel"
    );
    if (choice !== "Arm Auto-Compact") {
      await clearCheckboxSetting(SETTING_KEY);
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
      void clearCheckboxSetting(SETTING_KEY);
      return;
    }

    const read = readAutoCompactOverride();
    if (read.kind !== "present") {
      vscode.window.showWarningMessage(
        "WAT321 lost access to ~/.claude/settings.json. Try again in a moment."
      );
      void clearCheckboxSetting(SETTING_KEY);
      return;
    }
    const originalOverride = read.value;
    if (originalOverride === ARMED_OVERRIDE_VALUE) {
      vscode.window.showWarningMessage(
        "Your Claude auto-compact override is already set to 1. WAT321 will heal this on the next VS Code start. Run WAT321: Reset WAT321 if you need to unstick it now."
      );
      void clearCheckboxSetting(SETTING_KEY);
      return;
    }

    // Calculate an override percentage just below the current context
    // usage so exactly one compact fires. Claude checks this threshold
    // on each compact iteration - if we wrote "1" (compact at 1% of
    // window), every post-compact context still exceeds 1% and Claude
    // chains 4-5 compacts in rapid succession. By setting the threshold
    // to (currentPct - 5), the first compact fires (current > threshold)
    // but the post-compact context (typically 30-50% of original) falls
    // well below the threshold, stopping the loop cold.
    const currentPct = (ctx.contextUsed / ctx.contextWindowSize) * 100;
    const armOverride = String(Math.max(1, Math.floor(currentPct) - 5));

    let baselineSize = 0;
    try {
      baselineSize = statSync(ctx.transcriptPath).size;
    } catch {
      vscode.window.showWarningMessage(
        "WAT321 could not read the Claude transcript file. Try again in a moment."
      );
      void clearCheckboxSetting(SETTING_KEY);
      return;
    }

    const sentinel: ExperimentalAutoCompactSentinel = {
      version: 1,
      settingsPath: SETTINGS_PATH,
      originalOverride,
      armedOverride: armOverride,
      watchTranscriptPath: ctx.transcriptPath,
      baselineSize,
      armedAt: Date.now(),
    };

    if (!writeSentinel(sentinel)) {
      vscode.window.showWarningMessage(
        "WAT321 could not save its arm record. Check disk space and file permissions, then try again."
      );
      void clearCheckboxSetting(SETTING_KEY);
      return;
    }

    if (!writeAutoCompactOverride(armOverride)) {
      deleteSentinel();
      vscode.window.showWarningMessage(
        "WAT321 could not update ~/.claude/settings.json. Check that the file is not locked or read-only, then try again."
      );
      void clearCheckboxSetting(SETTING_KEY);
      return;
    }

    this.armedSentinel = sentinel;
    this.armedItem.show();

    vscode.window.showInformationMessage(
      "Claude Auto-Compact armed. Next prompt will trigger Auto-Compact."
    );

    this.startTranscriptWatch();
    this.startTimeout();
  }

  /** Watch the transcript file for growth. The moment the file grows
   * past its baseline size, the user's prompt has landed - Claude has
   * already read the override and committed to its compact decision.
   * Restore the override immediately and fully disarm. `fs.watch`
   * fires within milliseconds on all major platforms (Windows
   * ReadDirectoryChangesW, Linux inotify, macOS FSEvents). */
  private startTranscriptWatch(): void {
    const sentinel = this.armedSentinel;
    if (!sentinel) return;

    try {
      this.transcriptWatcher = watch(
        sentinel.watchTranscriptPath,
        { persistent: false },
        () => {
          // Guard: already disarmed or prompt already handled.
          if (!this.armedSentinel) return;

          try {
            const size = statSync(sentinel.watchTranscriptPath).size;
            if (size <= sentinel.baselineSize) return;
          } catch {
            return; // File mid-write, wait for next event
          }

          // Prompt landed. Restore override and fully disarm.
          this.disarm("prompt-detected");
        }
      );
    } catch {
      // fs.watch failed to start (permissions, unsupported FS).
      // The timeout backstop at ARM_WINDOW_MS will still disarm.
    }
  }

  private startTimeout(): void {
    this.timeoutTimer = setTimeout(() => {
      this.timeoutTimer = null;
      if (this.disposed || !this.armedSentinel) return;
      this.disarm("timeout");
    }, ARM_WINDOW_MS);
  }

  private closeTranscriptWatcher(): void {
    if (this.transcriptWatcher) {
      try {
        this.transcriptWatcher.close();
      } catch {
        // best-effort
      }
      this.transcriptWatcher = null;
    }
  }

  private disarm(reason: DisarmReason): void {
    const sentinel = this.armedSentinel;
    if (!sentinel) return;

    if (existsSync(SENTINEL_PATH)) {
      const target = safeRestoreValue(sentinel.originalOverride);
      if (!writeAutoCompactOverride(target)) {
        vscode.window.showErrorMessage(
          "WAT321 could not restore your Claude settings. Run WAT321: Reset WAT321 to unstick."
        );
        return;
      }
      deleteSentinel();
    }

    this.armedSentinel = null;
    this.closeTranscriptWatcher();
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    this.armedItem.dispose();

    if (reason === "prompt-detected" || reason === "timeout") {
      this.cooldownUntil = Date.now() + COOLDOWN_MS;
    }

    // Flip the checkbox off to reflect the disarmed state. Our
    // config listener short-circuits because armedSentinel is null.
    void clearCheckboxSetting(SETTING_KEY);

    // Prompt-detected disarm is silent - the user sees the compact
    // happen (or not) in their Claude session.
    if (reason === "prompt-detected") return;

    if (reason === "timeout") {
      vscode.window.showInformationMessage(
        "Claude Auto-Compact disarmed. No prompt detected within 30 seconds."
      );
    } else if (reason === "user-cancel") {
      vscode.window.showInformationMessage(
        "Claude Auto-Compact Disarmed. Cancelled."
      );
    }
  }

  /** Command handler for the armed status bar item's click. Wired
   * in `registerCancelExperimentalAutoCompactCommand` below. */
  cancelFromWidget(): void {
    if (!this.armedSentinel) return;
    this.disarm("user-cancel");
  }
}

/** Register the click-to-disarm command for the armed status bar
 * item. Called once during top-level `activate()` with a resolver
 * that returns the currently-active service instance (or null when
 * the Claude provider group is not active). The command id itself
 * lives in `armedStatusBarItem.ts` alongside the widget surface
 * that wires it. */
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
