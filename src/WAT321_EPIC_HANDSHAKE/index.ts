import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { EventHub } from "../engine/eventHub";
import { registerHealthSection } from "../engine/healthCommand";
import { SETTING } from "../engine/settingsKeys";
import {
  setBridgeActiveProbe,
  setRecentCodexCompletionConsumer,
} from "../engine/toastNotifier";
import { BridgeStageCoordinator } from "./bridgeStageCoordinator";
import {
  extractChannelScript,
  installChannel,
  isClaudeAvailable,
  isCodexAvailable,
  uninstallChannel,
} from "./channelInstaller";
import { CodexDispatcher } from "./codexDispatcher";
import { registerEpicHandshakeCommands } from "./commandRegistration";
import { LateReplyInboxCoordinator } from "./lateReplyInboxCoordinator";
import {
  EPIC_HANDSHAKE_DIR,
  inFlightFlagPath,
  PAUSED_FLAG_PATH,
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
import {
  applyDefaultWaitMode,
  createEpicHandshakeStatusBarItem,
  currentWaitMode,
  parseDefaultWaitMode,
} from "./statusBarItem";
import type { BridgeThreadRecord } from "./threadPersistence";
import {
  clearBridgeRuntimeFlags,
  consumeRecentCodexCompletion,
  writeCancelFlag,
} from "./turnFlags";
import { workspaceHash } from "./workspaceHash";

/** How long the restart-bridge orchestration waits between writing
 * the cancel sentinel and force-killing the app-server child. Long
 * enough for an in-flight `runTurnOnce` to observe the flag and write
 * its "cancelled by user" reply through the existing reply path; short
 * enough that a stuck bridge does not feel sluggish to recover. */
const RESTART_CANCEL_GRACE_MS = 500;

/**
 * Epic Handshake tier entry point. Sync MCP architecture:
 *
 *   - Enable flow runs `claude mcp add -s user wat321 -- node <path>`
 *     and extracts the MCP server plus its prod-only node_modules
 *     into `~/.wat321/epic-handshake/bin/`.
 *   - Any Claude session (extension panel or terminal) automatically
 *     sees the `epic_handshake_ask` and `epic_handshake_inbox` tools
 *     via MCP auto-discovery.
 *   - The extension-side `CodexDispatcher` watches `inbox/codex/` and
 *     drives `codex app-server` to produce replies; replies land in
 *     `inbox/claude/` where the blocked `epic_handshake_ask` tool
 *     call picks them up synchronously.
 *
 * Current scope: Claude -> Codex forward direction. Reverse
 * direction is future work.
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
    // workspace subfolder. Runs before clearStaleRuntimeFiles so a
    // migrated reply for THIS workspace is then properly swept by
    // the per-workspace cleanup.
    migrateLegacyEnvelopes(this.logger);
    // Clean stale state from a prior crash: an abandoned in-flight
    // flag would keep the widget animating forever, and stale mail
    // envelopes from a prior session are noise the user hasn't opted
    // into seeing. Both clears are best-effort.
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
        void this.startEnabled();
      }
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
      if (!opts.force && currentWaitMode() !== "standard") {
        // A flag is already on disk - either this window set it
        // earlier in the activate cycle, this window's menu click
        // set it during the prior session, or another VS Code window
        // has it set right now. In all three cases, leaving it alone
        // is correct: the user's "default" is what applies on a clean
        // launch, not on every activation.
        return;
      }
      const raw = vscode.workspace
        .getConfiguration("wat321")
        .get<string>(SETTING.epicHandshakeDefaultWaitMode, "Adaptive");
      applyDefaultWaitMode(parseDefaultWaitMode(raw));
    } catch {
      // best-effort; parseDefaultWaitMode falls back to Adaptive on any
      // unrecognized value, so a settings read failure leaves the user
      // in the same state as a fresh install.
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

  /** Reset hook: ensure cross-tool state is cleaned up synchronously
   * before Reset WAT321 wipes `~/.wat321/`. The listener-driven
   * disableFlow cannot be relied on here - it fires async from the
   * settings change and is not awaited by performClear, so the
   * `rmSync` would otherwise race ahead and leave a zombie MCP
   * entry in Claude's config. */
  async resetCleanup(): Promise<void> {
    await this.stopEnabled();
    try {
      await uninstallChannel(this.logger);
    } catch {
      // best-effort - reset must not fail if CLI removal glitches
    }
    // Wipe any staged clipboard screenshots; they are disposable and
    // the user expects Reset WAT321 to clear everything the tier
    // writes to disk.
    clearClipboardStaging();
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

  /** Epic Handshake bridges Claude and Codex; if either side is
   * disabled in WAT321's own settings the tier cannot function.
   * Enabling while a provider is off immediately flips the checkbox
   * back and surfaces a friendly explanation. Disabling a provider
   * while the bridge is already on auto-unchecks rather than leaves
   * it running half-wired. */
  private providersPresent(): boolean {
    const cfg = vscode.workspace.getConfiguration("wat321");
    return (
      cfg.get<boolean>(SETTING.enableClaude, true) === true &&
      cfg.get<boolean>(SETTING.enableCodex, true) === true
    );
  }

  private async unflipForMissingProvider(): Promise<void> {
    await vscode.workspace
      .getConfiguration("wat321")
      .update(SETTING.epicHandshakeEnabled, false, vscode.ConfigurationTarget.Global);
    void vscode.window.showWarningMessage(
      "Epic Handshake needs both Claude and Codex enabled in WAT321 settings. Turn them both on, then try again."
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
        // If the user disables Claude or Codex while Epic Handshake
        // is active, the bridge has nothing to bridge. Auto-uncheck
        // rather than leave it running half-wired.
        if (
          (e.affectsConfiguration(`wat321.${SETTING.enableClaude}`) ||
            e.affectsConfiguration(`wat321.${SETTING.enableCodex}`)) &&
          this.isEnabled() &&
          !this.providersPresent()
        ) {
          await this.unflipForMissingProvider();
          return;
        }
        if (
          e.affectsConfiguration(
            `wat321.${SETTING.epicHandshakeDefaultWaitMode}`
          )
        ) {
          // Settings change event = explicit user intent to switch the
          // default. Force-apply even if a flag already exists; the
          // user just edited the setting expecting it to take effect.
          this.applyDefaultWaitModeSetting({ force: true });
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
            "Epic Handshake needs the Claude Code CLI on your PATH. Install Claude Code (claude.ai/code) and re-enable when ready."
          );
          return;
        }

        progress.report({ message: "checking Codex install..." });
        const codexAvailable = await isCodexAvailable();
        if (!codexAvailable) {
          await this.unflipAndWarn(
            "Epic Handshake needs the Codex CLI on your PATH. Install Codex and re-enable when ready."
          );
          return;
        }

        progress.report({ message: "registering bridge channel..." });
        const res = await installChannel(this.context, this.logger);
        if (!res.ok) {
          await this.unflipAndWarn(
            `Epic Handshake could not register its bridge channel: ${res.error ?? "unknown error"}. Check the WAT321 Epic Handshake output channel for details.`
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
    await uninstallChannel(this.logger);
    // Clean paused sentinel so a later re-enable starts active, not
    // stuck-paused because the file lingered from prior use.
    try {
      if (existsSync(PAUSED_FLAG_PATH)) unlinkSync(PAUSED_FLAG_PATH);
    } catch {
      // best-effort
    }
    void vscode.window.showInformationMessage("Epic Handshake disabled.");
  }

  private async startEnabled(): Promise<void> {
    const ws =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    this.logger.info(`startEnabled workspace=${ws}`);
    // Refresh the bundled channel.mjs on every activate. Without this
    // the extension upgrade path leaves a stale channel.mjs on disk -
    // the script is only re-extracted during the Epic Handshake
    // enable-flow, so if the user already had EH enabled and just
    // reinstalled the vsix, new Claude sessions would still spawn
    // the old channel.mjs. Idempotent: writes are the same bytes
    // across concurrent VS Code instances. Best-effort: failure to
    // refresh leaves whatever is already on disk, which is no worse
    // than today.
    try {
      extractChannelScript(this.context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`channel.mjs refresh on activate failed: ${msg}`);
    }
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
  return {
    dispose: () => tier.deactivate(),
    resetCleanup: () => tier.resetCleanup(),
    bridgeStage: tier.bridgeStage,
    lateReplyInbox: tier.lateReplyInbox,
  };
}

/** Append Epic Handshake diagnostic lines to the health command
 * output. Called from `src/engine/healthCommand.ts`. Surfaces
 * per-workspace bridge state for debugging. */
export function appendEpicHandshakeHealth(lines: string[]): void {
  const enabled = vscode.workspace
    .getConfiguration("wat321")
    .get<boolean>(SETTING.epicHandshakeEnabled, false);
  lines.push("");
  lines.push("Epic Handshake");
  lines.push("-".repeat(30));
  lines.push(`  enabled: ${enabled}`);
  lines.push("  architecture: sync MCP bridge (Claude -> Codex forward direction)");

  if (!enabled) return;

  // Scan bridge-thread records for all workspaces on this machine.
  if (!existsSync(EPIC_HANDSHAKE_DIR)) {
    lines.push("  state: no on-disk state yet (nothing dispatched)");
    return;
  }

  let files: string[];
  try {
    files = readdirSync(EPIC_HANDSHAKE_DIR).filter(
      (f) => f.startsWith("bridge-thread.") && f.endsWith(".json")
    );
  } catch {
    lines.push("  state: unreadable");
    return;
  }

  if (files.length === 0) {
    lines.push("  state: no bridge threads yet");
    return;
  }

  for (const f of files) {
    try {
      const raw = readFileSync(join(EPIC_HANDSHAKE_DIR, f), "utf8");
      const rec = JSON.parse(raw) as BridgeThreadRecord;
      lines.push(`  workspace:     ${rec.workspacePath}`);
      lines.push(`    session:     S${rec.sessionCounter}${rec.threadId !== null ? ` (${rec.threadId.slice(0, 8)}...)` : " (null - fresh on next prompt)"}`);
      if (rec.lastSuccessAt) {
        lines.push(`    lastSuccess: ${new Date(rec.lastSuccessAt).toLocaleString()}`);
      }
      if ((rec.consecutiveFailures ?? 0) > 0) {
        lines.push(`    failures:    ${rec.consecutiveFailures} consecutive`);
        lines.push(`    lastError:   ${rec.lastError ?? "(unknown)"}`);
      }
      if (rec.lastResetAt) {
        lines.push(`    lastReset:   ${new Date(rec.lastResetAt).toLocaleString()}`);
      }
    } catch {
      lines.push(`  workspace: ${f} unreadable`);
    }
  }
}
