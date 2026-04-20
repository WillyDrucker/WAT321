import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { EventHub } from "../engine/eventHub";
import { registerHealthSection } from "../engine/healthCommand";
import { SETTING } from "../engine/settingsKeys";
import { setBridgeActiveProbe } from "../engine/toastNotifier";
import { installChannel, isClaudeAvailable, uninstallChannel } from "./channelInstaller";
import { CodexDispatcher } from "./codexDispatcher";
import {
  CANCEL_FLAG_PATH,
  EPIC_HANDSHAKE_DIR,
  FIRE_AND_FORGET_FLAG_PATH,
  INBOX_CLAUDE_DIR,
  IN_FLIGHT_FLAG_PATH,
  PAUSED_FLAG_PATH,
  PROCESSING_FLAG_PATH,
  RETURNING_FLAG_PATH,
  SENT_CLAUDE_DIR,
} from "./constants";
import { deleteCurrentCodexSession } from "./deleteCommand";
import { createOutputChannelLogger } from "./outputChannel";
import { createEpicHandshakeStatusBarItem } from "./statusBarItem";
import {
  loadBridgeThreadRecord,
  resetBridgeThread,
  type BridgeThreadRecord,
} from "./threadPersistence";

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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly events: EventHub
  ) {}

  activate(): void {
    // Clean stale state from a prior crash: an abandoned in-flight
    // flag would keep the widget animating forever, and stale mail
    // envelopes from a prior session are noise the user hasn't opted
    // into seeing. Both clears are best-effort.
    this.clearStaleRuntimeFiles();
    // Wire the probe so the engine's toast notifier can ask "is the
    // bridge currently dispatching?" without importing from this
    // tool. This preserves the one-way engine-depends-on-nothing
    // rule (the dependency flows tool -> engine via injection).
    setBridgeActiveProbe(() =>
      existsSync(IN_FLIGHT_FLAG_PATH) ||
      existsSync(PROCESSING_FLAG_PATH) ||
      existsSync(RETURNING_FLAG_PATH)
    );
    this.disposables.push(registerHealthSection(appendEpicHandshakeHealth));
    this.statusBar = createEpicHandshakeStatusBarItem(this.context, this.events);
    this.registerCommands();
    this.watchSetting();
    this.refreshStatusBar();
    // Periodic refresh drives both state transitions and animation
    // frames (1Hz arrow cycle, 2Hz delivered flash). 500ms is fast
    // enough for smooth pulses and light enough to be negligible:
    // cost is a few file stat calls per tick.
    this.refreshTimer = setInterval(() => this.refreshStatusBar(), 500);
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
  }

  deactivate(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    void this.stopEnabled();
    setBridgeActiveProbe(null);
    this.statusBar?.dispose();
    this.statusBar = null;
    this.loggerHandle.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
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
  }

  /** Sweep any orphan runtime files left behind by a prior crash or
   * abrupt VS Code exit. Called once on activate. The 1h safety TTL
   * for in-inbox mail is a separate path in the dispatcher; this is
   * just the activate-time clean slate the user chose over trying to
   * preserve possibly-stale late replies across sessions. */
  private clearStaleRuntimeFiles(): void {
    try {
      if (existsSync(IN_FLIGHT_FLAG_PATH)) unlinkSync(IN_FLIGHT_FLAG_PATH);
      if (existsSync(PROCESSING_FLAG_PATH)) unlinkSync(PROCESSING_FLAG_PATH);
      if (existsSync(RETURNING_FLAG_PATH)) unlinkSync(RETURNING_FLAG_PATH);
      if (existsSync(CANCEL_FLAG_PATH)) unlinkSync(CANCEL_FLAG_PATH);
      // Fire-and-forget is per-session by design: if the user opted
      // into it for a long prompt yesterday, today's fresh VS Code
      // window should start back in Standard (blocking) mode.
      if (existsSync(FIRE_AND_FORGET_FLAG_PATH)) unlinkSync(FIRE_AND_FORGET_FLAG_PATH);
      // Paused state intentionally persists across restarts: if the
      // user paused the bridge, they expect it to stay paused after
      // a VS Code reload, not silently un-pause.
    } catch {
      // best-effort
    }
    try {
      if (!existsSync(INBOX_CLAUDE_DIR)) return;
      if (!existsSync(SENT_CLAUDE_DIR)) mkdirSync(SENT_CLAUDE_DIR, { recursive: true });
      for (const f of readdirSync(INBOX_CLAUDE_DIR)) {
        if (!f.endsWith(".md")) continue;
        try {
          const src = join(INBOX_CLAUDE_DIR, f);
          const dst = join(SENT_CLAUDE_DIR, f);
          writeFileSync(dst, readFileSync(src));
          unlinkSync(src);
        } catch {
          // best-effort per file
        }
      }
    } catch {
      // best-effort sweep
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
      vscode.commands.registerCommand(
        "wat321.epicHandshake.enable",
        async () => {
          await vscode.workspace
            .getConfiguration("wat321")
            .update(
              SETTING.epicHandshakeEnabled,
              true,
              vscode.ConfigurationTarget.Global
            );
        }
      ),
      vscode.commands.registerCommand(
        "wat321.epicHandshake.disable",
        async () => {
          await vscode.workspace
            .getConfiguration("wat321")
            .update(
              SETTING.epicHandshakeEnabled,
              false,
              vscode.ConfigurationTarget.Global
            );
        }
      ),
      vscode.commands.registerCommand(
        "wat321.epicHandshake.resetCodexSession",
        async () => {
          const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (ws === undefined) {
            void vscode.window.showWarningMessage(
              "Epic Handshake: no workspace folder open."
            );
            return;
          }
          const current = loadBridgeThreadRecord(ws);
          const nextCounter = current.sessionCounter + 1;
          const confirm = await vscode.window.showInformationMessage(
            `Roll Codex to the next session? The current session stays visible in Codex's history. Next Claude to Codex prompt spawns a fresh S${nextCounter}.`,
            "Reset",
            "Cancel"
          );
          if (confirm !== "Reset") return;
          const next = resetBridgeThread(ws);
          this.refreshStatusBar();
          void vscode.window.showInformationMessage(
            `Epic Handshake: Codex session reset. Next Claude to Codex prompt spawns S${next.sessionCounter}.`
          );
          this.logger.info(`codex session reset -> S${next.sessionCounter}`);
        }
      ),
      vscode.commands.registerCommand(
        "wat321.epicHandshake.deleteCodexSession",
        async () => {
          await deleteCurrentCodexSession(this.logger);
          this.refreshStatusBar();
        }
      )
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
        const available = await isClaudeAvailable();
        if (!available) {
          await this.unflipAndWarn(
            "Epic Handshake needs the Claude Code CLI on your PATH. Install Claude Code (claude.ai/code) and re-enable when ready."
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
    if (this.dispatcher !== null) return;
    this.dispatcher = new CodexDispatcher(ws, this.logger);
    this.dispatcher.start();
  }

  private async stopEnabled(): Promise<void> {
    if (this.dispatcher === null) return;
    await this.dispatcher.stop();
    this.dispatcher = null;
  }
}

export function activateEpicHandshake(
  context: vscode.ExtensionContext,
  events: EventHub
): vscode.Disposable & { resetCleanup: () => Promise<void> } {
  const tier = new EpicHandshakeTier(context, events);
  tier.activate();
  return {
    dispose: () => tier.deactivate(),
    resetCleanup: () => tier.resetCleanup(),
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
