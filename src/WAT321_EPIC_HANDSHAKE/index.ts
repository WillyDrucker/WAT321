import { existsSync, unlinkSync } from "node:fs";
import * as vscode from "vscode";
import type { EventHub } from "../engine/eventHub";
import { registerHealthSection } from "../engine/healthCommand";
import { SETTING } from "../engine/settingsKeys";
import { appendEpicHandshakeHealth } from "./epicHandshakeHealth";
import {
  setBridgeActiveProbe,
  setRecentCodexCompletionConsumer,
} from "../engine/toastNotifier";
import { BridgeStageCoordinator } from "./bridgeStageCoordinator";
import {
  isClaudeAvailable,
  isCodexAvailable,
  isOpenCodeAvailable,
} from "./cliAvailability";
import { extractStageClipboardScript } from "./stageClipboardInstaller";
import { CodexDispatcher } from "./codexDispatcher";
import { registerEpicHandshakeCommands } from "./commandRegistration";
import { LateReplyInboxCoordinator } from "./lateReplyInboxCoordinator";
import {
  inFlightFlagPath,
  pausedFlagPath,
  processingFlagPath,
  returningFlagPath,
} from "./constants";
import {
  clearStaleRuntimeFiles,
  migrateLegacyEnvelopes,
} from "./legacyMigration";
import { createOutputChannelLogger } from "./outputChannel";
import {
  clearClipboardStaging,
  sweepStaleClipboardStages,
} from "./stageClipboardImage";
import { healLegacyAllowlistEntries } from "../shared/providers/claude/mcpAllowlist";
import { wipeWorkspaceEpicHandshakeState } from "./resetWipe";
import { registerSessionPickerCommands } from "./openCodeSessionsPicker";
import {
  applyDefaultWaitMode,
  createEpicHandshakeStatusBarItem,
  currentWaitMode,
} from "./statusBarItem";
import {
  clearBridgeRuntimeFlags,
  consumeRecentCodexCompletion,
  writeCancelFlag,
} from "./turnFlags";
import { workspaceHash } from "../shared/workspaceHash";

/** How long the restart-bridge orchestration waits between writing
 * the cancel sentinel and force-killing the app-server child. Long
 * enough for an in-flight `runTurnOnce` to observe the flag and write
 * its "cancelled by user" reply through the existing reply path; short
 * enough that a stuck bridge does not feel sluggish to recover. */
const RESTART_CANCEL_GRACE_MS = 500;

/**
 * Epic Handshake tier entry point. Sync MCP architecture:
 *
 *   - Enable flow runs `claude mcp add -s project wat321 -- node <path>`
 *     against the unified MCP installer, which extracts the bridge
 *     scripts plus prod-only node_modules into `~/.wat321/bridge/bin/`.
 *   - Any Claude session sees `wat321_ask` (dispatch), `wat321_session`
 *     (session lifecycle), and `wat321_bridge` (single-purpose inbox
 *     drain) via MCP auto-discovery.
 *   - The extension-side `CodexDispatcher` watches `inbox/codex/` and
 *     drives `codex app-server` to produce replies; replies land in
 *     `inbox/claude/` where the blocking `wat321_ask` call picks them
 *     up synchronously, or where `wat321_bridge()` drains them when
 *     the caller used fire-and-forget.
 */

class EpicHandshakeTier {
  private readonly disposables: vscode.Disposable[] = [];
  private dispatcher: CodexDispatcher | null = null;
  private readonly loggerHandle = createOutputChannelLogger();
  private readonly logger = this.loggerHandle.logger;
  private statusBar: ReturnType<typeof createEpicHandshakeStatusBarItem> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  readonly bridgeStage: BridgeStageCoordinator;
  readonly lateReplyInbox: LateReplyInboxCoordinator;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly events: EventHub
  ) {
    this.bridgeStage = new BridgeStageCoordinator(events);
    this.lateReplyInbox = new LateReplyInboxCoordinator(events);
  }

  activate(): void {
    // Coordinators are constructed in the ctor but their polling loops
    // start here so subscribers (toast notifier probes wired below,
    // status bar refresh handlers) register before the first tick fires.
    this.bridgeStage.start();
    this.lateReplyInbox.start();
    // One-time migration: any envelopes left in the un-partitioned
    // `inbox/codex/*.md` or `inbox/claude/*.md` (legacy layout before
    // workspace partitioning) get moved into their envelope's
    // workspace subfolder so subsequent reads find them by hash.
    migrateLegacyEnvelopes(this.logger);
    // Clean stale runtime sentinels from a prior crash: an abandoned
    // in-flight flag would keep the widget animating forever. Pending
    // inbox replies are NOT cleared - a Codex reply that landed
    // mid-shutdown must survive activation so the next inbox check
    // delivers it. Best-effort.
    clearStaleRuntimeFiles();
    // Clipboard-staging dir is a separate folder for screenshot
    // attachments the user wants Codex to see. Sweep anything older
    // than the TTL so a long-forgotten paste does not sit on disk.
    sweepStaleClipboardStages(this.logger);
    // Wire the probe so the engine's toast notifier can ask "is the
    // bridge currently dispatching?" without importing from this
    // tool. This preserves the one-way engine-depends-on-nothing
    // rule (the dependency flows tool -> engine via injection).
    // Probe only flags its own workspace's flags so a sibling VS Code
    // instance's active turn does not make this window's toast
    // notifier suppress Codex notifications for unrelated activity.
    setBridgeActiveProbe(() => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) return false;
      const hash = workspaceHash(ws);
      return (
        existsSync(inFlightFlagPath(hash)) ||
        existsSync(processingFlagPath(hash)) ||
        existsSync(returningFlagPath(hash))
      );
    });
    // Consume-on-read complement to the active probe. The dispatcher
    // writes a one-shot suppress sentinel on successful turn complete;
    // the toast notifier drains it when Codex's transcript-driven
    // responseComplete event fires (which can land more than 5s after
    // the returning flag has cleared).
    setRecentCodexCompletionConsumer(() => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) return false;
      return consumeRecentCodexCompletion(ws);
    });
    this.disposables.push(registerHealthSection(appendEpicHandshakeHealth));
    this.statusBar = createEpicHandshakeStatusBarItem(
      this.context,
      this.events,
      this.bridgeStage,
      this.lateReplyInbox
    );
    this.registerCommands();
    this.watchSetting();
    this.refreshStatusBar();
    // Periodic refresh drives both state transitions and animation
    // frames. 1000ms is a trade: every tick that the tooltip text
    // changes (e.g. wait-time counter tick) causes VS Code to reshow
    // the MarkdownString hover overlay - a fundamental VS Code
    // limitation we cannot suppress. Halving the refresh from 500ms
    // to 1000ms halves the worst-case blink frequency at the cost
    // of the arrow animations running at 0.5Hz instead of 1Hz, which
    // is still visibly pulsing. File-stat cost per tick is
    // negligible either way.
    this.refreshTimer = setInterval(() => this.refreshStatusBar(), 1000);
    // Bridge state coordinator emits phase + stage transitions as
    // they happen (driven by fs-watch on heartbeat/flag/envelope
    // writes within ~50ms). Refresh on each event so the status bar
    // reflects state changes instantly instead of waiting for the
    // next 1s animation tick.
    this.disposables.push(
      this.events.on("bridge.phaseChanged", () => this.refreshStatusBar()),
      this.events.on("bridge.stageChanged", () => this.refreshStatusBar()),
      this.events.on("inbox.countChanged", () => this.refreshStatusBar())
    );
    if (this.isEnabled()) {
      if (!this.providersPresent()) {
        // Settings say "on" but a provider got switched off between
        // sessions. Flip the checkbox off instead of starting a
        // bridge that cannot succeed.
        void this.unflipForMissingProvider();
      } else {
        // Activate-time sweep of retired bridge tools. The install
        // path runs this too, but a user whose EH was already on at
        // upgrade never re-runs the installer - so without an
        // activate-time pass their `~/.claude.json` keeps any orphaned
        // legacy allowlist entries. Idempotent. No-op when the entries
        // are absent. Best-effort. Never blocks startEnabled.
        try {
          healLegacyAllowlistEntries(this.logger);
        } catch {
          // best-effort - activation continues regardless
        }
        void this.startEnabled();
      }
    } else {
      // Activate-time reconciliation when disabled. A sibling VS Code
      // instance running with EH enabled writes a user-scope MCP entry
      // into ~/.claude.json; that entry is global and persists across
      // VS Code restarts. Without this blind uninstall an instance
      // that has EH disabled in its own settings would still see the
      // bridge tools advertised on every Claude session, paying the
      // catalog token cost for a feature it never opted into. The
      // command is idempotent and best-effort - cheap when nothing is
      // registered, no-op if Claude CLI is missing.
      void vscode.commands.executeCommand("wat321.bridge.uninstallUnified");
    }
    this.applyDefaultWaitModeSetting();
  }

  /** Read the user's preferred default wait mode from settings and
   * write the matching flag files. Called from three places so the
   * setting cannot get stranded:
   *   - tier construct (initial activate) - respect existing flag
   *   - settings change watcher (live edit) - force apply
   *   - enable flow (flipping EH on after a settings change) - respect existing flag
   *
   * The flag files (`adaptive.flag` / `fire-and-forget.flag`) live at
   * a single global path under `~/.wat321/epic-handshake/`. They are
   * shared across every running VS Code window. Activating a fresh
   * window must NOT silently rewrite a flag another window already
   * set via menu click - doing so flips that other window's mode
   * mid-session. Only an explicit settings-change event has the
   * authority to override; otherwise we respect whatever flag is
   * already on disk and only seed when none exists (Standard /
   * fresh install).
   *
   * Subsequent menu toggles always override this; menu writes go
   * direct via `applyWaitMode`. The flag-file readers in the widget /
   * menu pick up the change on the next refresh tick. */
  private applyDefaultWaitModeSetting(opts: { force?: boolean } = {}): void {
    try {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) return;
      if (!opts.force && currentWaitMode(ws) !== "standard") {
        // A flag is already on disk for THIS workspace - this window
        // set it earlier in the activate cycle, or its menu click set
        // it during the prior session. Leaving it alone is correct:
        // the user's "default" applies on a clean launch only, not on
        // every activation. With per-workspace partitioning, sibling
        // windows on the same machine never read this window's flag,
        // so no cross-instance contamination is possible.
        return;
      }
      // Adaptive is the fixed default at activate. The click menu still
      // toggles between Adaptive and Fire-and-Forget at runtime, but the
      // launch default is hardcoded - no user-facing setting.
      applyDefaultWaitMode("adaptive", ws);
    } catch {
      // best-effort
    }
  }


  deactivate(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    void this.stopEnabled();
    setBridgeActiveProbe(null);
    setRecentCodexCompletionConsumer(null);
    this.statusBar?.dispose();
    this.statusBar = null;
    this.loggerHandle.dispose();
    this.bridgeStage.dispose();
    this.lateReplyInbox.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  /** "Restart Codex Bridge" main-menu action. Bundles three things:
   *
   *   1. Cancel any in-flight turn (writes the cancel sentinel; the
   *      runTurnOnce poll surfaces a "cancelled by user" reply if it
   *      fires before step 3 force-kills the app-server).
   *   2. Force-kill the dispatcher's `codex app-server` child process
   *      (SIGKILL, no SIGTERM grace) so a stuck or stale-config server
   *      is gone immediately. Next dispatch spawns a fresh one with
   *      whatever config.toml currently holds.
   *   3. Wipe per-workspace runtime flags (in-flight, processing,
   *      returning, cancel, suppress-toast) so the status bar widget
   *      returns to idle and the next turn starts from a clean state.
   *
   * Preserves: bridge thread record (S<n> resumes on next prompt),
   * mode flags (paused / adaptive / fire-and-forget), sandbox flag,
   * late replies, session_index. The user's intentional state survives;
   * only the stuck runtime cruft is cleared.
   *
   * Zero impact on the Claude session - Claude's MCP connection is to
   * `channel.mjs`, not the dispatcher's app-server. Nothing Claude can
   * see changes. */
  async restartBridge(): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws !== undefined) {
      writeCancelFlag(ws);
    }
    // Brief grace so an in-flight runTurnOnce can observe the cancel
    // flag and write its "cancelled by user" reply before the next
    // step kills the connection underneath it.
    await new Promise((r) => setTimeout(r, RESTART_CANCEL_GRACE_MS));
    this.dispatcher?.forceRestart();
    if (ws !== undefined) {
      clearBridgeRuntimeFlags(ws);
    }
    this.logger.info("bridge restarted via main-menu action");
    // Pre-warm immediately so the user's next dispatch after the
    // restart is fast. Without this, "Restart Codex Bridge" would
    // re-introduce the cold-start the activate-time prewarm just
    // saved them from.
    const prewarmTimer = setTimeout(() => {
      void this.dispatcher?.prewarm();
    }, 500);
    prewarmTimer.unref?.();
  }

  /** Reset hook: tear down EH services and wipe THIS workspace's
   * EH state. Runs synchronously before performClear's scoped disk
   * wipe so a stuck MCP entry cannot survive into the post-reset
   * state. Peer windows' wsHash subfolders and shared bin/ are
   * intentionally untouched - reset is workspace-scoped. */
  async resetCleanup(): Promise<void> {
    await this.stopEnabled();
    try {
      await vscode.commands.executeCommand("wat321.bridge.uninstallUnified");
    } catch {
      // best-effort - reset must not fail if CLI removal glitches
    }
    clearClipboardStaging();
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) {
      wipeWorkspaceEpicHandshakeState(workspaceHash(ws));
    }
  }

  private refreshStatusBar(): void {
    if (this.statusBar === null) return;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    this.statusBar.refresh({ enabled: this.isEnabled(), workspacePath: ws });
  }

  private isEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("wat321")
      .get<boolean>(SETTING.epicHandshakeEnabled, false) === true;
  }

  /** Epic Handshake routes Claude to Codex and/or OpenCode. Claude is
   * always required; at least one of (Codex, OpenCode) must also be
   * enabled in WAT321's own settings. Enabling EH while no backend
   * is available immediately flips the checkbox back and surfaces a
   * friendly explanation; disabling the only enabled backend while
   * EH is on auto-unchecks rather than leaves it running half-wired. */
  private providersPresent(): boolean {
    const cfg = vscode.workspace.getConfiguration("wat321");
    const claudeOn = cfg.get<boolean>(SETTING.enableClaude, true) === true;
    const codexOn = cfg.get<boolean>(SETTING.enableCodex, true) === true;
    const openCodeOn = cfg.get<boolean>(SETTING.enableOpenCode, false) === true;
    return claudeOn && (codexOn || openCodeOn);
  }

  private async unflipForMissingProvider(): Promise<void> {
    await vscode.workspace
      .getConfiguration("wat321")
      .update(SETTING.epicHandshakeEnabled, false, vscode.ConfigurationTarget.Global);
    void vscode.window.showWarningMessage(
      "Epic Handshake needs Claude plus Codex and/or OpenCode enabled in WAT321 settings. Turn one of those backends on, then try again."
    );
  }

  private registerCommands(): void {
    this.disposables.push(
      ...registerEpicHandshakeCommands({
        logger: this.logger,
        refreshStatusBar: () => this.refreshStatusBar(),
        restartCodexBridge: () => this.restartBridge(),
      })
    );
  }

  private watchSetting(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        // If the user disables Claude (mandatory) or both backends
        // (Codex AND OpenCode) while Epic Handshake is active, the
        // bridge has nothing to bridge. Auto-uncheck rather than leave
        // it running half-wired.
        if (
          (e.affectsConfiguration(`wat321.${SETTING.enableClaude}`) ||
            e.affectsConfiguration(`wat321.${SETTING.enableCodex}`) ||
            e.affectsConfiguration(`wat321.${SETTING.enableOpenCode}`)) &&
          this.isEnabled() &&
          !this.providersPresent()
        ) {
          await this.unflipForMissingProvider();
          return;
        }
        if (
          !e.affectsConfiguration(`wat321.${SETTING.epicHandshakeEnabled}`)
        ) {
          return;
        }
        if (this.isEnabled()) {
          if (!this.providersPresent()) {
            await this.unflipForMissingProvider();
            return;
          }
          await this.enableFlow();
        } else {
          await this.disableFlow();
        }
      })
    );
  }

  private async enableFlow(): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Setting up Epic Handshake",
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "checking Claude Code install..." });
        const claudeAvailable = await isClaudeAvailable();
        if (!claudeAvailable) {
          await this.unflipAndWarn(
            "Epic Handshake needs the Claude Code CLI. Either install the Claude Code VS Code extension from the Marketplace, or install the standalone CLI (claude.ai/code), then re-enable."
          );
          return;
        }

        // Epic Handshake routes Claude to Codex and/or OpenCode; at
        // least one of those CLIs must be reachable for the bridge to
        // do anything useful. Both missing => unflip and warn. Either
        // present => activation proceeds; the unified bridge handlers
        // gracefully report "not installed" on dispatches to whichever
        // backend is missing.
        progress.report({ message: "checking backend installs..." });
        const [codexAvailable, openCodeAvailable] = await Promise.all([
          isCodexAvailable(),
          isOpenCodeAvailable(),
        ]);
        if (!codexAvailable && !openCodeAvailable) {
          await this.unflipAndWarn(
            "Epic Handshake needs at least one backend installed: the Codex CLI or the OpenCode CLI (`npm i -g opencode-ai`). Install either one, then re-enable."
          );
          return;
        }

        progress.report({ message: "registering bridge channel..." });
        try {
          // installUnifiedBridge sweeps stale entries from
          // `~/.claude.json`'s projects tree and runs `claude mcp
          // remove` before the fresh `claude mcp add` (which would
          // otherwise error on duplicate-name).
          await vscode.commands.executeCommand("wat321.bridge.installUnified");
        } catch (err) {
          await this.unflipAndWarn(
            `Epic Handshake could not register the unified bridge: ${
              err instanceof Error ? err.message : String(err)
            }. Check the WAT321 Bridge output channel for details.`
          );
          return;
        }

        progress.report({ message: "starting dispatcher..." });
        this.applyDefaultWaitModeSetting();
        await this.startEnabled();

        void vscode.window.showInformationMessage(
          "Epic Handshake is ready. Send a prompt to Codex using natural language like \"Review your findings with Codex...\" to use. New sessions work automatically, active sessions will have to be restarted. Note: Resuming existing Claude sessions counts towards usage."
        );
      }
    );
  }

  /** Flip the checkbox off on enable-flow failure so the user is
   * not stuck looking at a setting that lies about actual state. */
  private async unflipAndWarn(message: string): Promise<void> {
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

  private async disableFlow(): Promise<void> {
    await this.stopEnabled();
    // EH is the single switch now - the unified `wat321` MCP entry
    // is the only registration in play, and uninstallUnifiedBridge
    // sweeps both user and project scope on its own. Idempotent so a
    // missing entry is silently absorbed.
    try {
      await vscode.commands.executeCommand("wat321.bridge.uninstallUnified");
    } catch {
      // best-effort - sweep is meant to be idempotent
    }
    // Clean paused sentinel so a later re-enable starts active, not
    // stuck-paused because the file lingered from prior use. Per
    // workspace - only clears THIS window's paused state; siblings
    // keep their own paused choice.
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

  private async startEnabled(): Promise<void> {
    const ws =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    this.logger.info(`startEnabled workspace=${ws}`);
    // Refresh stage-clipboard.mjs on every activate. The script is
    // invoked by Claude via Bash (absolute path under
    // ~/.wat321/epic-handshake/bin/) when staging clipboard images
    // for bridge prompts; without this refresh, an extension upgrade
    // would leave the old helper on disk and Claude sessions would
    // run stale code. Idempotent: writes are the same bytes across
    // concurrent VS Code instances. Best-effort: failure leaves
    // whatever is already on disk, which is no worse than today.
    try {
      extractStageClipboardScript(this.context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`stage-clipboard.mjs refresh on activate failed: ${msg}`);
    }
    // Refresh the unified bridge scripts + docs on every activate, same
    // reasoning as stage-clipboard above. They otherwise re-extract only on
    // the explicit EH enable toggle, so a user who already has EH enabled
    // and just upgrades the extension would keep the prior release's
    // channel.mjs / codex.mjs / docs until a re-toggle. Dispatched as a
    // command to avoid importing the MCP-server installer across the tier
    // boundary - the same command-crossing the install / uninstall flow uses.
    void vscode.commands.executeCommand("wat321.bridge.refreshUnifiedScripts");
    if (this.dispatcher !== null) return;
    this.dispatcher = new CodexDispatcher(ws, this.logger);
    this.dispatcher.start();
    // No activate-time codex daemon spawn. The dispatcher is now
    // entirely lazy: the codex app-server is spawned on-demand by
    // `ensureClient()` inside `runTurnOnce` the first time a bridge
    // envelope actually lands. The trade-off is that the first bridge
    // dispatch after a VS Code launch pays the ~20s cold-start chain
    // (spawn + Node init + config load + JSON-RPC handshake); the
    // bridge widget's stage-1 ceremony covers the wait visually. The
    // benefit is that cold launching VS Code spawns zero CLI
    // subprocesses on our behalf, keeping the audit surface clean.
    // The post-`Restart Codex Bridge` prewarm in `restartBridge`
    // remains because that command is a deliberate user action whose
    // whole point is to leave the bridge ready for the next dispatch.
  }

  private async stopEnabled(): Promise<void> {
    if (this.dispatcher === null) return;
    await this.dispatcher.stop();
    this.dispatcher = null;
  }
}

export interface EpicHandshakeHandle extends vscode.Disposable {
  resetCleanup: () => Promise<void>;
  /** Concrete coordinator the EH tier owns. Re-exposed so the
   * activator (`extension.ts`) can pass it to bootstrap, where the
   * Claude/Codex session-token widgets need a `BridgeStageReader`
   * to render the bridge-driven prefix animations. */
  bridgeStage: BridgeStageCoordinator;
  lateReplyInbox: LateReplyInboxCoordinator;
}

export function activateEpicHandshake(
  context: vscode.ExtensionContext,
  events: EventHub
): EpicHandshakeHandle {
  const tier = new EpicHandshakeTier(context, events);
  tier.activate();
  // Cross-tier command surface: lets the Local LLM widget click open
  // the per-target Manage Sessions submenu without importing from
  // this tier directly (engine-blessed crossing via command dispatch).
  registerSessionPickerCommands(context);
  return {
    dispose: () => tier.deactivate(),
    resetCleanup: () => tier.resetCleanup(),
    bridgeStage: tier.bridgeStage,
    lateReplyInbox: tier.lateReplyInbox,
  };
}
