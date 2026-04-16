import { existsSync, statSync } from "node:fs";
import * as vscode from "vscode";
import {
  readAutoCompactOverride,
  SETTINGS_PATH,
  writeAutoCompactOverride,
} from "../shared/claudeSettings";
import { clearCheckboxSetting, SETTING_KEY_FORCE_AUTOCOMPACT } from "../shared/clearSettings";
import type { ClaudeSessionTokenService } from "../WAT321_CLAUDE_SESSION_TOKENS/service";
import type { WidgetState as ClaudeTokenWidgetState } from "../WAT321_CLAUDE_SESSION_TOKENS/types";
import { ArmedStatusBarItem, CANCEL_COMMAND_ID } from "./armedStatusBarItem";
import { ARMED_OVERRIDE_VALUE } from "./backups";
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
 *   - Unticking the box while armed disarms immediately, restores
 *     the override, disposes the armed widget, and surfaces a
 *     `Claude Auto-Compact Disarmed. Cancelled.` toast.
 *
 *   - Clicking the red `! ARMED` status bar item disarms the same
 *     way as unticking.
 *
 *   - On compact detection or timeout, the service disarms,
 *     restores the override, disposes the armed status bar item,
 *     and unticks the box. If no prompt was observed, each path
 *     shows its own information toast. Once a prompt lands in the
 *     transcript, the widget hides silently and the timeout
 *     extends to 3 minutes to allow long compacts to finish.
 *
 * Safety contracts:
 *   - Sentinel records the user's original override (custom string
 *     or `null` for "key absent"). On disarm or heal, sentinel
 *     value is restored; if sentinel is missing, the key is deleted
 *     so Claude falls back to its own built-in default formula.
 *     The armed value `"1"` is poison-checked and never restored.
 *   - `healStuckOverride()` on startup unsticks any override left
 *     stuck by a crash in a previous session.
 *   - On activation, the setting is force-reset to `false` so a
 *     `true` value left across a VS Code restart never auto-arms.
 *   - `dispose()` runs a synchronous best-effort restore before
 *     clearing timers and listeners so a mid-arm provider teardown
 *     still unsticks the override.
 */

const SETTING_KEY = SETTING_KEY_FORCE_AUTOCOMPACT;
const FULL_SETTING_PATH = `wat321.${SETTING_KEY}`;

/** Window in which the tool waits for a prompt after arming. If the
 * user never types, we time out and disarm loudly. */
const ARM_WINDOW_MS = 30_000;

/** Extended window after a prompt has been observed in the transcript.
 * A real compact can take well over the initial 30 s window to finish,
 * especially on long sessions, so once we see the user's prompt land
 * we wait up to three minutes for the compact marker before giving up.
 * If the marker never arrives we still restore settings - this is the
 * backstop, not the happy path. */
const ARM_WINDOW_MS_POST_PROMPT = 180_000;

/** Post-disarm cooldown during which re-arming is refused. */
const COOLDOWN_MS = 30_000;

/** Poll cadence while armed. */
const POLL_INTERVAL_MS = 2_000;

type DisarmReason = "user-cancel" | "compact-detected" | "timeout";

export class ExperimentalAutoCompactService {
  private armedSentinel: ExperimentalAutoCompactSentinel | null = null;
  private armedScanOffset = 0;
  /** Set to true the first poll after arming where we observe the
   * transcript file grow past its baseline size. Marks "the user's
   * next prompt has landed in the transcript", which is the signal
   * that the user's intent has been captured and Claude has committed
   * to whatever compact decision it is going to make for this turn.
   * We silently hide the !ARMED widget at that moment (no toast) and
   * extend the compact-wait window to `ARM_WINDOW_MS_POST_PROMPT` so
   * a long compact still finishes cleanly. Reset to false on every
   * fresh arm and on every disarm. */
  private promptObserved = false;
  private cooldownUntil = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
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
      armedOverride: ARMED_OVERRIDE_VALUE,
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

    if (!writeAutoCompactOverride(ARMED_OVERRIDE_VALUE)) {
      deleteSentinel();
      vscode.window.showWarningMessage(
        "WAT321 could not update ~/.claude/settings.json. Check that the file is not locked or read-only, then try again."
      );
      void clearCheckboxSetting(SETTING_KEY);
      return;
    }

    this.armedSentinel = sentinel;
    this.armedScanOffset = baselineSize;
    this.promptObserved = false;
    this.armedItem.show();

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
          "WAT321 could not restore your Claude settings. Run WAT321: Reset WAT321 to unstick."
        );
        return;
      }
      deleteSentinel();
    }

    const wasPromptObserved = this.promptObserved;
    this.armedSentinel = null;
    this.promptObserved = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.armedItem.dispose();

    if (reason === "compact-detected" || reason === "timeout") {
      this.cooldownUntil = Date.now() + COOLDOWN_MS;
    }

    // Flip the checkbox off to reflect the disarmed state. Our
    // config listener short-circuits because armedSentinel is null.
    void clearCheckboxSetting(SETTING_KEY);

    // Once the user's prompt has landed we clean up silently - the
    // user already saw the compact either fire or not fire on their
    // end and a second toast telling them about it is noise. The
    // !ARMED widget was already hidden at prompt-observation time.
    if (wasPromptObserved) return;

    if (reason === "compact-detected") {
      vscode.window.showInformationMessage(
        "Auto-compact fired. Your Claude settings have been restored."
      );
    } else if (reason === "timeout") {
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
      this.armedItem.dispose();
      void clearCheckboxSetting(SETTING_KEY);
      return;
    }

    // Timeout failsafe: restore even if compact never fired.
    // Extended window once a prompt has already been observed so a
    // long compact has time to actually land its summary marker.
    const windowLimit = this.promptObserved
      ? ARM_WINDOW_MS_POST_PROMPT
      : ARM_WINDOW_MS;
    if (Date.now() - sentinel.armedAt > windowLimit) {
      this.disarm("timeout");
      return;
    }

    try {
      const size = statSync(sentinel.watchTranscriptPath).size;
      // Prompt observation: the transcript only grows when a new turn
      // is written, so any growth past the baseline means the user's
      // prompt has landed. Silently hide the !ARMED widget on the
      // first such poll. Settings stay armed; we keep polling for
      // the compact marker under the extended timeout.
      if (!this.promptObserved && size > sentinel.baselineSize) {
        this.promptObserved = true;
        this.armedItem.dispose();
      }
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
