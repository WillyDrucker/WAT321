import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";
import {
  isConfigInstallable,
  readConfigFromSettings,
  writeConfigFile,
  type ModelBridgeConfig,
} from "./config";
import { MODEL_BRIDGE_DIR } from "./constants";
import { uninstallModelBridge } from "./installer";
import { createModelBridgeLogger, type ModelBridgeLogger } from "./outputChannel";
import { createOpenCodeManager } from "./openCodeManager";
import { clearZenApiKey, promptAndStoreZenApiKey, readSecret, ZEN_API_KEY_SECRET } from "./secrets";
import { createModelBridgeStatusBarItem } from "./statusBarItem";
import { pickActiveInstance } from "./statusBarMenu";

/**
 * Model Bridge tier entry. Lifecycle:
 *
 *   activate -> persist current settings to config.json
 *            -> if installable AND Claude CLI present, register MCP entry
 *
 *   settings change -> rewrite config.json atomically (channel.mjs picks
 *                      up new values on its next call without a restart)
 *                   -> if installable transition flipped, install or
 *                      uninstall MCP entry to match
 *
 *   secrets change -> rewrite config.json so a freshly-stored Zen key
 *                     reaches channel.mjs without a window reload.
 *
 *   deactivate -> dispose output channel + settings watcher.
 *                 Does NOT uninstall the MCP entry on deactivate
 *                 (matches Epic Handshake; the entry persists across
 *                 VS Code restarts so Claude Code keeps the tool
 *                 between sessions). Reset WAT321 calls
 *                 `resetCleanup` to fully tear down.
 */

export interface ModelBridgeHandle {
  resetCleanup(): Promise<void>;
  dispose(): void;
}

export function activateModelBridge(
  context: vscode.ExtensionContext
): ModelBridgeHandle {
  const { logger, channel } = createModelBridgeLogger();
  context.subscriptions.push({ dispose: () => channel.dispose() });

  const statusBar = createModelBridgeStatusBarItem(context, logger);
  context.subscriptions.push({ dispose: () => statusBar.dispose() });

  const openCodeManager = createOpenCodeManager(logger);
  context.subscriptions.push({ dispose: () => void openCodeManager.dispose() });

  let lastInstallable = false;
  // First-pass guard. Without this, the activate-time call short-
  // circuits when desired state is `false` because lastInstallable is
  // already `false` - leaving any stale MCP entry from a sibling VS
  // Code instance (or from a prior crash) registered in Claude's user
  // scope. Forcing the first reconcile to actually run install or
  // uninstall closes that leakage path.
  let everReconciled = false;

  const applyCurrentConfig = async (): Promise<void> => {
    const cfg = vscode.workspace.getConfiguration("wat321");
    const enabled = cfg.get<boolean>(SETTING.modelBridgeEnabled, false);
    const localEndpoint = cfg
      .get<string>(SETTING.modelBridgeLocalEndpoint, "http://127.0.0.1:8080")
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

    const installable = isConfigInstallable(config);
    if (everReconciled && installable === lastInstallable) {
      return;
    }
    lastInstallable = installable;
    everReconciled = true;

    if (installable) {
      await reconcileInstall(context, config, logger);
    } else {
      await uninstallModelBridge(logger);
    }
  };

  // Apply once at activate so the config file exists before
  // channel.mjs is ever spawned. The MCP entry only registers if
  // settings are complete enough to call out.
  void applyCurrentConfig();

  // Track Model Bridge enable transitions so we toast the user on
  // off->on (with the same "what to do next" voice as Epic Handshake's
  // enable toast) and on on->off (matches EH "disabled." toast).
  // Initialized from current setting at activate so a settings event
  // fired during startup-flush doesn't get treated as a transition.
  let lastEnabledState = vscode.workspace
    .getConfiguration("wat321")
    .get<boolean>(SETTING.modelBridgeEnabled, false);

  // Settings watcher: rewrite config.json + reconcile MCP entry on
  // any wat321.modelBridge.* change. Cheap (atomic file write +
  // optional CLI call) so doing this every keystroke in settings.json
  // is fine.
  const watcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (
      e.affectsConfiguration(`wat321.${SETTING.modelBridgeEnabled}`) ||
      e.affectsConfiguration(`wat321.${SETTING.modelBridgeLocalEndpoint}`)
    ) {
      const nowEnabled = vscode.workspace
        .getConfiguration("wat321")
        .get<boolean>(SETTING.modelBridgeEnabled, false);
      if (nowEnabled !== lastEnabledState) {
        if (nowEnabled) {
          void vscode.window.showInformationMessage(
            "Model Bridge is ready. Send prompts to OpenCode/Local LLM using natural language like \"Ask Big Pickle to ...\" or \"Ask the local LLM ...\" to use. New Claude sessions pick up the new tools automatically; active sessions need to be restarted. Note: resuming existing Claude sessions counts toward usage."
          );
        } else {
          void vscode.window.showInformationMessage("Model Bridge disabled.");
        }
        lastEnabledState = nowEnabled;
      }
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
    vscode.Uri.file(MODEL_BRIDGE_DIR),
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
    // the legacy MB click menu opens.
    vscode.commands.registerCommand(
      "wat321.modelBridge.pickActiveInstance",
      async () => {
        await pickActiveInstance(context);
      }
    )
  );

  return {
    async resetCleanup(): Promise<void> {
      await uninstallModelBridge(logger);
      try {
        await context.secrets.delete(ZEN_API_KEY_SECRET);
      } catch {
        // best-effort
      }
      await openCodeManager.dispose();
      lastInstallable = false;
    },
    dispose(): void {
      watcher.dispose();
      void openCodeManager.dispose();
      logger.dispose();
    },
  };
}

/** Install the MCP entry. Skips registration when the `claude` CLI is
 * not available - the user can configure Model Bridge settings before
 * installing Claude Code, in which case the bridge silently waits
 * until both are present. */
async function reconcileInstall(
  _context: vscode.ExtensionContext,
  _config: ModelBridgeConfig,
  logger: ModelBridgeLogger
): Promise<void> {
  // The legacy `wat321-model-bridge` MCP entry is retired - everything
  // flows through the unified `wat321` server installed by the bridge
  // tier on Epic Handshake enable. This tier's reconcileInstall now
  // exists only to sweep any stale legacy entry from prior installs;
  // the opencode serve subprocess and click-menu state continue to
  // run regardless because the unified handlers depend on them.
  await uninstallModelBridge(logger);
}
