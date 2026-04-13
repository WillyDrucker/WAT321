import { existsSync, statSync } from "node:fs";
import * as vscode from "vscode";
import {
  readAutoCompactOverride,
  SETTINGS_PATH,
  writeAutoCompactOverride,
} from "../shared/claudeSettings";
import type { ClaudeSessionTokenService } from "../WAT321_CLAUDE_SESSION_TOKENS/service";
import {
  ARMED_OVERRIDE_VALUE,
  maybeCaptureInstallSnapshot,
  rotateArmBackup,
} from "./backups";
import { scanForCompactMarker } from "./compactDetector";
import { healStuckOverride, safeRestoreValue, type HealResult } from "./heal";
import { deleteSentinel, SENTINEL_PATH, writeSentinel } from "./sentinel";
import type { ExperimentalAutoCompactSentinel } from "./types";

/**
 * Experimental Force Claude Auto-Compact service. Triggered entirely
 * through the `wat321.experimental.forceClaudeAutoCompact` setting
 * checkbox - no status bar widget, no preflight gate, no passive
 * availability resolver, no consent prompt.
 *
 * The flow is:
 *   1. User toggles the setting ON.
 *   2. We capture the current `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` into
 *      the sentinel + arm backup ring and lower it to "1".
 *   3. We poll the active Claude transcript for the compact marker.
 *   4. On compact detected OR 30s timeout, we restore the original
 *      value, delete the sentinel, flip the setting back to OFF, and
 *      enter a 30s cooldown that refuses re-arming.
 *   5. The user may also toggle OFF mid-arm; that routes through the
 *      same restore path with a "user-cancel" reason (silent, no toast).
 *
 * Safety contracts:
 *   - Sentinel + 3-slot arm backup ring + install snapshot + hardcoded
 *     default form a four-tier restore precedence chain, poison-checked
 *     at every tier against the armed value "1".
 *   - `healStuckOverride()` on startup unsticks any override left
 *     stuck at "1" by a crash in a previous session.
 *   - On activation, the setting is force-reset to `false` so a value
 *     left `true` across a VS Code restart never auto-arms silently.
 */

const SETTING_KEY = "experimental.forceClaudeAutoCompact";
const FULL_SETTING_PATH = `wat321.${SETTING_KEY}`;

/** Window in which the tool waits for a compact marker after arming. */
const ARM_WINDOW_MS = 30_000;

/** Post-disarm cooldown during which re-arming is refused. */
const COOLDOWN_MS = 30_000;

/** Poll cadence while armed. */
const POLL_INTERVAL_MS = 2_000;

type DisarmReason = "user-cancel" | "compact-detected" | "timeout";

export class ExperimentalAutoCompactService {
  private armedSentinel: ExperimentalAutoCompactSentinel | null = null;
  private armedScanOffset = 0;
  private cooldownUntil = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private configListener: vscode.Disposable | null = null;
  private disposed = false;

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
    // state. A `true` value left across restart would otherwise arm
    // immediately on startup, which is surprising behavior. Silent -
    // the user will see the checkbox unchecked next time they open
    // settings.
    const current = vscode.workspace
      .getConfiguration("wat321")
      .get<boolean>(SETTING_KEY, false);
    if (current) {
      vscode.workspace
        .getConfiguration("wat321")
        .update(SETTING_KEY, false, vscode.ConfigurationTarget.Global)
        .then(undefined, () => {
          // best-effort
        });
    }

    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(FULL_SETTING_PATH)) return;
      const enabled = vscode.workspace
        .getConfiguration("wat321")
        .get<boolean>(SETTING_KEY, false);
      // Idempotent: only act when the setting and our internal state
      // disagree. Our own writes land here too, but they always match
      // our state (we flip setting -> false after we set armedSentinel
      // -> null), so they no-op automatically. No internal-update flag
      // needed.
      if (enabled && !this.armedSentinel) {
        this.arm();
      } else if (!enabled && this.armedSentinel) {
        this.disarm("user-cancel");
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // If we are armed at dispose time, restore the override
    // synchronously before tearing down. This covers: Claude provider
    // disabled mid-arm, VS Code closing mid-arm, any other teardown
    // while a cycle is still in flight. Without this, the override
    // would stay at "1" until the next start's heal failsafe picked
    // it up - functional but not clean, and a user who then kept
    // using Claude outside VS Code would sit in exactly the
    // unintended auto-compact loop this tool is meant to prevent.
    // Best-effort: if the write fails, leave the sentinel on disk so
    // the next-start heal chain still unsticks the user.
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
  }

  /** Exposed for the Reset WAT321 path so it can heal a stuck override
   * without holding a reference to service internals. */
  static healStuckOverride(): HealResult {
    return healStuckOverride();
  }

  private arm(): void {
    if (this.armedSentinel) return;

    const now = Date.now();
    if (now < this.cooldownUntil) {
      const remaining = Math.ceil((this.cooldownUntil - now) / 1000);
      vscode.window.showWarningMessage(
        `WAT321 just finished a Force Auto-Compact cycle. Wait ${remaining} second${remaining !== 1 ? "s" : ""} before arming again.`
      );
      this.resetSetting();
      return;
    }

    const transcriptPath = this.tokenService.getActiveTranscriptPath();
    if (!transcriptPath) {
      vscode.window.showWarningMessage(
        "WAT321 could not find an active Claude Code session to target. Open Claude Code and send a prompt first, then try again."
      );
      this.resetSetting();
      return;
    }

    const read = readAutoCompactOverride();
    if (read.kind !== "present") {
      vscode.window.showWarningMessage(
        "WAT321 lost access to ~/.claude/settings.json. Try again in a moment."
      );
      this.resetSetting();
      return;
    }
    const originalOverride = read.value;
    if (originalOverride === ARMED_OVERRIDE_VALUE) {
      vscode.window.showWarningMessage(
        "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE is already set to 1. WAT321 will heal this on the next VS Code start. Run WAT321: Reset All Settings if you need to unstick it now."
      );
      this.resetSetting();
      return;
    }

    let baselineSize = 0;
    try {
      baselineSize = statSync(transcriptPath).size;
    } catch {
      vscode.window.showWarningMessage(
        "WAT321 could not read the Claude transcript file. Try again in a moment."
      );
      this.resetSetting();
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
      watchTranscriptPath: transcriptPath,
      baselineSize,
      armedAt: Date.now(),
    };

    if (!writeSentinel(sentinel)) {
      vscode.window.showWarningMessage(
        "WAT321 could not save its arm record. Check disk space and file permissions, then try again."
      );
      this.resetSetting();
      return;
    }

    if (!writeAutoCompactOverride(ARMED_OVERRIDE_VALUE)) {
      deleteSentinel();
      vscode.window.showWarningMessage(
        "WAT321 could not update ~/.claude/settings.json. Check that the file is not locked or read-only, then try again."
      );
      this.resetSetting();
      return;
    }

    this.armedSentinel = sentinel;
    this.armedScanOffset = baselineSize;

    vscode.window.showInformationMessage(
      "Claude Auto-Compact armed. Your next message to Claude will trigger an auto-compact. Auto-disarms in 30 seconds if no compaction occurs."
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

    if (reason === "compact-detected" || reason === "timeout") {
      this.cooldownUntil = Date.now() + COOLDOWN_MS;
    }

    // Flip the checkbox off to reflect the disarmed state. Our config
    // listener short-circuits because armedSentinel is already null.
    this.resetSetting();

    if (reason === "compact-detected") {
      vscode.window.showInformationMessage(
        "Auto-compact fired. Your Claude settings have been restored."
      );
    } else if (reason === "timeout") {
      vscode.window.showInformationMessage(
        "Claude Force Auto-Compact timed out without detecting a compaction. Your Claude settings have been restored."
      );
    }
    // user-cancel is silent - the user just unchecked the box.
  }

  private resetSetting(): void {
    vscode.workspace
      .getConfiguration("wat321")
      .update(SETTING_KEY, false, vscode.ConfigurationTarget.Global)
      .then(undefined, () => {
        // best-effort
      });
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
      this.resetSetting();
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
