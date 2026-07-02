import { existsSync, unlinkSync } from "node:fs";
import * as vscode from "vscode";
import { workspaceHash } from "../shared/workspaceHash";
import { SETTING } from "../engine/settingsKeys";
import { resetCliResolverCache } from "../shared/providers/cliResolver";
import {
  isClaudeAvailable,
  isCodexAvailable,
  isOpenCodeAvailable,
} from "./cliAvailability";
import { pausedFlagPath } from "./constants";
import { applyDefaultWaitMode, currentWaitMode } from "./statusBarItem";

/**
 * Settings-driven enable / disable flow for the Epic Handshake tier.
 * The tier class in `index.ts` owns construction and runtime state -
 * this module owns the "user just flipped the checkbox" path - CLI
 * preflight, bridge registration, dispatcher start/stop, the friendly
 * unflip-and-warn surface when prerequisites are missing, and the
 * settings-watch wiring.
 */

export interface EnableFlowDeps {
  /** Logger forwarded to bridge install/uninstall commands. */
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
  /** Start the dispatcher + activate the bridge. Called after the
   * checkbox-on flow's CLI preflight + registration succeed. */
  startBridge: () => Promise<void>;
  /** Stop the dispatcher. Called at the start of the disable flow. */
  stopBridge: () => Promise<void>;
}

/** Read the EH enabled checkbox. */
export function isEpicHandshakeEnabled(): boolean {
  return (
    vscode.workspace
      .getConfiguration("wat321")
      .get<boolean>(SETTING.epicHandshakeEnabled, false) === true
  );
}

/** Epic Handshake routes Claude to Codex and/or OpenCode. Claude is
 * always required - at least one of (Codex, OpenCode) must also be
 * enabled in WAT321's own settings. */
export function epicHandshakeProvidersPresent(): boolean {
  const cfg = vscode.workspace.getConfiguration("wat321");
  const claudeOn = cfg.get<boolean>(SETTING.enableClaude, true) === true;
  const codexOn = cfg.get<boolean>(SETTING.enableCodex, true) === true;
  const openCodeOn = cfg.get<boolean>(SETTING.enableOpenCode, false) === true;
  return claudeOn && (codexOn || openCodeOn);
}

/** Flip the EH checkbox off and surface a missing-provider warning. */
export async function unflipForMissingProvider(): Promise<void> {
  await vscode.workspace
    .getConfiguration("wat321")
    .update(SETTING.epicHandshakeEnabled, false, vscode.ConfigurationTarget.Global);
  void vscode.window.showWarningMessage(
    "Epic Handshake needs Claude plus Codex and/or OpenCode enabled in WAT321 settings. Turn one of those backends on, then try again."
  );
}

/** Flip the checkbox off on enable-flow failure so the user is not
 * stuck looking at a setting that lies about actual state. */
export async function unflipAndWarn(message: string): Promise<void> {
  void vscode.window.showWarningMessage(message);
  try {
    await vscode.workspace
      .getConfiguration("wat321")
      .update(
        SETTING.epicHandshakeEnabled,
        false,
        vscode.ConfigurationTarget.Global
      );
  } catch {
    // best-effort
  }
}

/** Run the "EH checkbox just flipped on" flow: progress UI, CLI
 * preflight on every backend, bridge channel registration, dispatcher
 * start. Self-unflips with a friendly warning on any failure so the
 * setting never lies about actual state. */
export async function runEnableFlow(deps: EnableFlowDeps): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Setting up Epic Handshake",
      cancellable: false,
    },
    async (progress) => {
      // Flush CLI resolver caches so a backend the user just installed
      // is re-probed now instead of returning a stale "missing" result
      // cached earlier this session.
      resetCliResolverCache();
      progress.report({ message: "checking Claude Code install..." });
      const claudeAvailable = await isClaudeAvailable();
      if (!claudeAvailable) {
        await unflipAndWarn(
          "Epic Handshake needs the Claude Code CLI. Either install the Claude Code VS Code extension from the Marketplace, or install the standalone CLI (claude.ai/code), then re-enable."
        );
        return;
      }

      // At least one of Codex / OpenCode must be reachable for the
      // bridge to do anything useful. Either present => activation
      // proceeds - the unified bridge handlers gracefully report "not
      // installed" on dispatches to whichever backend is missing.
      progress.report({ message: "checking backend installs..." });
      const [codexAvailable, openCodeAvailable] = await Promise.all([
        isCodexAvailable(),
        isOpenCodeAvailable(),
      ]);
      if (!codexAvailable && !openCodeAvailable) {
        await unflipAndWarn(
          "Epic Handshake needs at least one backend installed: the Codex CLI or the OpenCode CLI (`npm i -g opencode-ai`). Install either one, then re-enable."
        );
        return;
      }

      progress.report({ message: "registering bridge channel..." });
      try {
        // installUnifiedBridge sweeps stale entries from
        // `~/.claude.json`'s projects tree and runs `claude mcp
        // remove` before the fresh `claude mcp add`.
        await vscode.commands.executeCommand("wat321.bridge.installUnified");
      } catch (err) {
        await unflipAndWarn(
          `Epic Handshake could not register the unified bridge: ${
            err instanceof Error ? err.message : String(err)
          }. Check the WAT321 Bridge output channel for details.`
        );
        return;
      }

      progress.report({ message: "starting dispatcher..." });
      seedDefaultWaitMode();
      await deps.startBridge();

      void vscode.window.showInformationMessage(
        'Epic Handshake is ready. Send a prompt to Codex using natural language like "Review your findings with Codex..." to use. New sessions work automatically, active sessions will have to be restarted. Note: Resuming existing Claude sessions counts towards usage.'
      );
    }
  );
}

/** Run the "EH checkbox just flipped off" flow: stop dispatcher,
 * uninstall the unified bridge MCP entry, clear the per-workspace
 * paused sentinel so a later re-enable starts active. */
export async function runDisableFlow(deps: EnableFlowDeps): Promise<void> {
  await deps.stopBridge();
  // EH is the single switch now. uninstallUnifiedBridge sweeps both
  // user and project scope on its own. Idempotent.
  try {
    await vscode.commands.executeCommand("wat321.bridge.uninstallUnified");
  } catch {
    // best-effort - sweep is meant to be idempotent
  }
  try {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) {
      const path = pausedFlagPath(workspaceHash(ws));
      if (existsSync(path)) unlinkSync(path);
    }
  } catch {
    // best-effort
  }
  void vscode.window.showInformationMessage("Epic Handshake disabled.");
}

/** Subscribe to settings changes that affect EH. When the user
 * disables a required provider (Claude, or both Codex AND OpenCode)
 * while EH is on, auto-unflip rather than leave the bridge running
 * half-wired. When the EH checkbox itself flips, drive the enable/
 * disable flow. */
export function watchEnableSetting(deps: EnableFlowDeps): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (
      (e.affectsConfiguration(`wat321.${SETTING.enableClaude}`) ||
        e.affectsConfiguration(`wat321.${SETTING.enableCodex}`) ||
        e.affectsConfiguration(`wat321.${SETTING.enableOpenCode}`)) &&
      isEpicHandshakeEnabled() &&
      !epicHandshakeProvidersPresent()
    ) {
      await unflipForMissingProvider();
      return;
    }
    if (!e.affectsConfiguration(`wat321.${SETTING.epicHandshakeEnabled}`)) {
      return;
    }
    if (isEpicHandshakeEnabled()) {
      if (!epicHandshakeProvidersPresent()) {
        await unflipForMissingProvider();
        return;
      }
      await runEnableFlow(deps);
    } else {
      await runDisableFlow(deps);
    }
  });
}

/** Seed the per-workspace wait-mode flag at activate time. Respects
 * an existing flag (this window or a prior session already set one)
 * unless `force: true`. The setting only seeds Standard / fresh
 * install state - menu toggles always override. */
export function seedDefaultWaitMode(opts: { force?: boolean } = {}): void {
  try {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return;
    if (!opts.force && currentWaitMode(ws) !== "standard") {
      // A flag is already on disk - leave it alone. The user's
      // default applies on a clean launch only.
      return;
    }
    // Adaptive is the fixed default at activate. The click menu still
    // toggles between Adaptive and Fire-and-Forget at runtime.
    applyDefaultWaitMode("adaptive", ws);
  } catch {
    // best-effort
  }
}
