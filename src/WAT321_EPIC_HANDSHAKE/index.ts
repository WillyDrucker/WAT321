import * as vscode from "vscode";
import type { EventHub } from "../engine/eventHub";
import { registerHealthSection } from "../engine/healthCommand";
import { InboxCoordinator } from "../engine/inbox/inboxCoordinator";
import { healLegacyAllowlistEntries } from "../shared/providers/claude/mcpAllowlist";
import { BridgeStageCoordinator } from "./bridgeStage/bridgeStageCoordinator";
import { wireBridgeToastProbes } from "./statusBar/bridgeToastProbes";
import { CodexDispatcher } from "./codexTurn/codexDispatcher";
import { registerEpicHandshakeCommands } from "./commandRegistration";
import {
  epicHandshakeProvidersPresent,
  isEpicHandshakeEnabled,
  seedDefaultWaitMode,
  unflipForMissingProvider,
  watchEnableSetting,
} from "./epicHandshakeEnableFlow";
import { appendEpicHandshakeHealth } from "./epicHandshakeHealth";
import { createOutputChannelLogger } from "./epicHandshakeLogger";
import {
  clearStaleRuntimeFiles,
  migrateLegacyEnvelopes,
} from "./repair/legacyMigration";
import { registerSessionPickerCommands } from "./openCodeSessions/openCodeSessionsPicker";
import { wipeWorkspaceEpicHandshakeState } from "./repair/resetWipe";
import {
  clearClipboardStaging,
  sweepStaleClipboardStages,
} from "./stageClipboardImage";
import { extractStageClipboardScript } from "./stageClipboardInstaller";
import { createEpicHandshakeStatusBarItem } from "./statusBar/statusBarItem";
import { clearBridgeRuntimeFlags, writeCancelFlag } from "./codexTurn/turnFlags";

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
 *     drives `codex app-server` to produce replies - replies land in
 *     `inbox/claude/` where the blocking `wat321_ask` call picks them
 *     up synchronously, or where `wat321_bridge()` drains them when
 *     the caller used fire-and-forget.
 *
 * Enable / disable flow + setting watcher + provider checks live in
 * `epicHandshakeEnableFlow.ts`, the toast notifier probes in
 * `bridgeToastProbes.ts`. This file owns the tier class + its
 * activation lifecycle + the runtime orchestration (restart, reset,
 * dispatcher start/stop).
 */

/** How long the restart-bridge orchestration waits between writing
 * the cancel sentinel and force-killing the app-server child. Long
 * enough for an in-flight runTurnOnce to observe the flag and write
 * its "cancelled by user" reply - short enough that recovery feels
 * snappy. */
const RESTART_CANCEL_GRACE_MS = 500;
/** Delay before the post-restart prewarm, so the force-kill has
 * settled before a fresh child spawns. */
const RESTART_PREWARM_DELAY_MS = 500;
const STATUS_BAR_REFRESH_MS = 1000;

class EpicHandshakeTier {
  private readonly disposables: vscode.Disposable[] = [];
  private dispatcher: CodexDispatcher | null = null;
  private readonly loggerHandle = createOutputChannelLogger();
  private readonly logger = this.loggerHandle.logger;
  private statusBar: ReturnType<typeof createEpicHandshakeStatusBarItem> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  readonly bridgeStage: BridgeStageCoordinator;
  readonly lateReplyInbox: InboxCoordinator;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly events: EventHub
  ) {
    this.bridgeStage = new BridgeStageCoordinator(events);
    this.lateReplyInbox = new InboxCoordinator(events);
  }

  activate(): void {
    this.bridgeStage.start();
    this.lateReplyInbox.start();
    // One-time migration: envelopes left in the un-partitioned legacy
    // layout (`inbox/codex/*.md`) get moved into their envelope's
    // workspace subfolder. Stale runtime sentinels from a prior crash
    // are also cleared so an abandoned in-flight flag does not pin
    // the widget. Pending inbox replies survive activation.
    migrateLegacyEnvelopes(this.logger);
    clearStaleRuntimeFiles();
    sweepStaleClipboardStages(this.logger);
    this.disposables.push(wireBridgeToastProbes());
    this.disposables.push(registerHealthSection(appendEpicHandshakeHealth));
    this.statusBar = createEpicHandshakeStatusBarItem(
      this.context,
      this.events,
      this.bridgeStage,
      this.lateReplyInbox
    );
    this.disposables.push(
      ...registerEpicHandshakeCommands({
        logger: this.logger,
        refreshStatusBar: () => this.refreshStatusBar(),
        restartCodexBridge: () => this.restartBridge(),
      })
    );
    this.disposables.push(
      watchEnableSetting({
        logger: this.logger,
        startBridge: () => this.startBridge(),
        stopBridge: () => this.stopBridge(),
      })
    );
    this.refreshStatusBar();
    // 1Hz refresh: every tooltip-text change causes VS Code to reshow
    // the hover overlay - a fundamental VS Code limitation - so going
    // faster than 1Hz makes the hover blink visibly. File-stat cost
    // per tick is negligible.
    this.refreshTimer = setInterval(
      () => this.refreshStatusBar(),
      STATUS_BAR_REFRESH_MS
    );
    this.disposables.push(
      this.events.on("bridge.phaseChanged", () => this.refreshStatusBar()),
      this.events.on("bridge.stageChanged", () => this.refreshStatusBar()),
      this.events.on("inbox.countChanged", () => this.refreshStatusBar())
    );
    if (isEpicHandshakeEnabled()) {
      if (!epicHandshakeProvidersPresent()) {
        void unflipForMissingProvider();
      } else {
        // Activate-time sweep of retired bridge tools. A user whose
        // EH was already on at upgrade never re-runs the installer
        // path, so without this their `~/.claude.json` keeps orphaned
        // legacy allowlist entries. Idempotent, best-effort.
        try {
          healLegacyAllowlistEntries(this.logger);
        } catch {
          // best-effort
        }
        void this.startBridge();
      }
    } else {
      // EH disabled but a sibling VS Code instance running with EH
      // enabled writes a user-scope MCP entry that persists across
      // restarts. Without this blind uninstall this window would
      // still see bridge tools advertised on every Claude session.
      // Idempotent + best-effort.
      void vscode.commands.executeCommand("wat321.bridge.uninstallUnified");
    }
    seedDefaultWaitMode();
  }

  deactivate(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    void this.stopBridge();
    this.statusBar?.dispose();
    this.statusBar = null;
    this.loggerHandle.dispose();
    this.bridgeStage.dispose();
    this.lateReplyInbox.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  /** "Restart Codex Bridge" main-menu action. Cancels any in-flight
   * turn, force-kills the dispatcher's app-server child, clears per-
   * workspace runtime flags so the widget returns to idle. Preserves
   * bridge thread record (S<n> resumes), mode flags, sandbox flag,
   * late replies, session_index - only stuck runtime cruft is
   * cleared. Pre-warms the next dispatch so the user does not re-pay
   * the cold-start. */
  async restartBridge(): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws !== undefined) {
      writeCancelFlag(ws);
    }
    // Brief grace so an in-flight runTurnOnce can observe the cancel
    // flag and write its "cancelled by user" reply before the kill.
    await new Promise((r) => setTimeout(r, RESTART_CANCEL_GRACE_MS));
    this.dispatcher?.forceRestart();
    if (ws !== undefined) {
      clearBridgeRuntimeFlags(ws);
    }
    this.logger.info("bridge restarted via main-menu action");
    const prewarmTimer = setTimeout(() => {
      void this.dispatcher?.prewarm();
    }, RESTART_PREWARM_DELAY_MS);
    prewarmTimer.unref?.();
  }

  /** Reset hook: tear down EH services and wipe THIS workspace's EH
   * state. Runs synchronously before performClear's scoped disk wipe
   * so a stuck MCP entry cannot survive. Workspace-scoped - peer
   * windows' wsHash subfolders and shared bin/ are untouched. */
  async resetCleanup(): Promise<void> {
    await this.stopBridge();
    try {
      await vscode.commands.executeCommand("wat321.bridge.uninstallUnified");
    } catch {
      // best-effort - reset must not fail if CLI removal glitches
    }
    clearClipboardStaging();
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) {
      wipeWorkspaceEpicHandshakeState(ws);
    }
  }

  private refreshStatusBar(): void {
    if (this.statusBar === null) return;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    this.statusBar.refresh({
      enabled: isEpicHandshakeEnabled(),
      workspacePath: ws,
    });
  }

  private async startBridge(): Promise<void> {
    const ws =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    this.logger.info(`startBridge workspace=${ws}`);
    // Refresh stage-clipboard.mjs on every activate. The script is
    // invoked by Claude via Bash (absolute path under
    // ~/.wat321/epic-handshake/bin/) - without this refresh, an
    // extension upgrade would leave the old helper on disk and Claude
    // sessions would run stale code. Idempotent + best-effort.
    try {
      extractStageClipboardScript(this.context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`stage-clipboard.mjs refresh on activate failed: ${msg}`);
    }
    // Refresh the unified bridge scripts + docs on every activate so
    // a user who already has EH enabled picks up upgrades without
    // re-toggling.
    void vscode.commands.executeCommand("wat321.bridge.refreshUnifiedScripts");
    if (this.dispatcher !== null) return;
    this.dispatcher = new CodexDispatcher(ws, this.logger);
    this.dispatcher.start();
    // No activate-time codex daemon spawn. The app-server spawns
    // lazily on the first bridge envelope - first dispatch pays the
    // cold-start, subsequent dispatches are warm. Restart Codex
    // Bridge pre-warms because that user action's point is to leave
    // the bridge ready.
  }

  private async stopBridge(): Promise<void> {
    if (this.dispatcher === null) return;
    await this.dispatcher.stop();
    this.dispatcher = null;
  }
}

interface EpicHandshakeHandle extends vscode.Disposable {
  resetCleanup: () => Promise<void>;
  /** Concrete coordinator the EH tier owns. Re-exposed so the
   * activator (`extension.ts`) can pass it to bootstrap, where the
   * Claude/Codex session-token widgets need a `BridgeStageReader`
   * to render the bridge-driven prefix animations. */
  bridgeStage: BridgeStageCoordinator;
  lateReplyInbox: InboxCoordinator;
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
