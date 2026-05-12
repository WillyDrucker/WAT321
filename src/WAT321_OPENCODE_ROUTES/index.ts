import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";
import {
  readConfigFromSettings,
  writeConfigFile,
} from "./config";
import { OPENCODE_ROUTES_DIR } from "./constants";
import { createOpenCodeRoutesLogger } from "./outputChannel";
import { createOpenCodeManager } from "./harness";
import { clearZenApiKey, promptAndStoreZenApiKey, readSecret, ZEN_API_KEY_SECRET } from "./secrets";
import { createOpenCodeRoutesStatusBarItem } from "./statusBarItem";
import { pickActiveInstance } from "./statusBarMenu";

/**
 * OpenCode Routes tier entry. Lifecycle:
 *
 *   activate -> persist current settings to config.json so
 *               channel.mjs reads the live snapshot on every call
 *
 *   settings change -> rewrite config.json atomically (channel.mjs
 *                      picks up new values on its next call without
 *                      a restart)
 *
 *   secrets change -> rewrite config.json so a freshly-stored Zen
 *                     key reaches channel.mjs without a window reload
 *
 *   deactivate -> dispose output channel + settings watcher. The MCP
 *                 entry itself is owned by WAT321_MCP_SERVER and
 *                 persists across VS Code restarts. Reset WAT321
 *                 calls `resetCleanup` to fully tear down.
 */

export interface OpenCodeRoutesHandle {
  resetCleanup(): Promise<void>;
  dispose(): void;
}

export function activateOpenCodeRoutes(
  context: vscode.ExtensionContext
): OpenCodeRoutesHandle {
  const { logger, channel } = createOpenCodeRoutesLogger();
  context.subscriptions.push({ dispose: () => channel.dispose() });

  const statusBar = createOpenCodeRoutesStatusBarItem(context, logger);
  context.subscriptions.push({ dispose: () => statusBar.dispose() });

  const openCodeManager = createOpenCodeManager(logger);
  context.subscriptions.push({ dispose: () => void openCodeManager.dispose() });

  // Activate-time `applyCurrentConfig` can resolve `reconcile` with
  // "" (first-spawn failure or an input race) and write config.json
  // with an empty harness URL even when a follow-up spawn ultimately
  // succeeds. The manager reports every URL transition and the
  // listener re-runs the merge so config.json always tracks the live
  // harness state instead of pinning the racy first result.
  const urlSub = openCodeManager.onUrlChanged(() => {
    void applyCurrentConfig();
  });
  context.subscriptions.push(urlSub);

  const applyCurrentConfig = async (): Promise<void> => {
    const cfg = vscode.workspace.getConfiguration("wat321");
    const enabled = cfg.get<boolean>(SETTING.enableOpenCode, true);
    const localEndpoint = cfg
      .get<string>(SETTING.localEndpoint, "")
      .trim()
      .replace(/\/+$/, "");
    const zenKey = (await readSecret(context, ZEN_API_KEY_SECRET)) ?? "";

    // Managed local opencode-serve is the only harness target now;
    // when OpenCode is enabled, reconcile spawns it. Disabling
    // OpenCode kills the subprocess.
    const managedUrl = await openCodeManager.reconcile({
      enabled,
      localEndpoint,
      zenApiKey: zenKey,
    });

    const config = await readConfigFromSettings(context, managedUrl);
    const written = writeConfigFile(config);
    if (!written) {
      logger.warn("config.json write failed; channel.mjs will see prior values");
    }
  };

  // Apply once at activate so the config file exists before
  // channel.mjs is ever spawned. The MCP entry only registers if
  // settings are complete enough to call out.
  void applyCurrentConfig();

  // Settings watcher: rewrite config.json + reconcile harness on any
  // change to `wat321.enableOpenCode` or `wat321.localEndpoint`. Cheap
  // (atomic file write + optional subprocess respawn) so doing this
  // every keystroke in settings.json is fine. No toast on enable /
  // disable - Epic Handshake already owns the enable-flow toast and
  // the OpenCode widget visibility flip is its own visual signal.
  const watcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (
      e.affectsConfiguration(`wat321.${SETTING.enableOpenCode}`) ||
      e.affectsConfiguration(`wat321.${SETTING.localEndpoint}`)
    ) {
      void applyCurrentConfig();
    }
  });
  context.subscriptions.push(watcher);

  // SecretStorage watcher: a freshly-stored Zen key has to flow into
  // config.json so channel.mjs sees it on the next call. Without
  // this, the user would have to toggle the bridge or re-save
  // settings to force a config rewrite.
  const secretWatcher = context.secrets.onDidChange((e) => {
    if (e.key === ZEN_API_KEY_SECRET) {
      void applyCurrentConfig();
    }
  });
  context.subscriptions.push(secretWatcher);

  // Per-task tunings live in preferences.json (driven by the click
  // menu, not VS Code settings). Watch the file so a click-menu edit
  // also rewrites the merged config.json that channel.mjs reads.
  const prefsPattern = new vscode.RelativePattern(
    vscode.Uri.file(OPENCODE_ROUTES_DIR),
    "preferences.json"
  );
  const prefsWatcher = vscode.workspace.createFileSystemWatcher(prefsPattern);
  prefsWatcher.onDidChange(() => void applyCurrentConfig());
  prefsWatcher.onDidCreate(() => void applyCurrentConfig());
  prefsWatcher.onDidDelete(() => void applyCurrentConfig());
  context.subscriptions.push(prefsWatcher);

  // Commands.
  context.subscriptions.push(
    vscode.commands.registerCommand("wat321.modelBridge.setZenApiKey", async () => {
      await promptAndStoreZenApiKey(context);
    }),
    vscode.commands.registerCommand("wat321.modelBridge.clearZenApiKey", async () => {
      await clearZenApiKey(context);
    }),
    // Cross-tier entry point: the EH widget's Manage OpenCode Sessions
    // submenu's MODEL row dispatches here so it can swap the active
    // instance without importing from this tier directly. Same picker
    // the legacy OpenCode Routes click menu opens.
    vscode.commands.registerCommand(
      "wat321.modelBridge.pickActiveInstance",
      async (kindFilter?: "remote" | "local") => {
        await pickActiveInstance(context, kindFilter);
      }
    )
  );

  return {
    async resetCleanup(): Promise<void> {
      try {
        await context.secrets.delete(ZEN_API_KEY_SECRET);
      } catch {
        // best-effort
      }
      await openCodeManager.dispose();
    },
    dispose(): void {
      watcher.dispose();
      void openCodeManager.dispose();
      logger.dispose();
    },
  };
}

