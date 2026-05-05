import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";
import {
  isConfigInstallable,
  readConfigFromSettings,
  writeConfigFile,
  type ModelBridgeConfig,
} from "./config";
import { MODEL_BRIDGE_DIR } from "./constants";
import {
  installModelBridge,
  isClaudeAvailable,
  uninstallModelBridge,
} from "./installer";
import { createModelBridgeLogger, type ModelBridgeLogger } from "./outputChannel";
import { clearZenApiKey, promptAndStoreZenApiKey, ZEN_API_KEY_SECRET } from "./secrets";
import { createModelBridgeStatusBarItem } from "./statusBarItem";

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

  let lastInstallable = false;
  // First-pass guard. Without this, the activate-time call short-
  // circuits when desired state is `false` because lastInstallable is
  // already `false` - leaving any stale MCP entry from a sibling VS
  // Code instance (or from a prior crash) registered in Claude's user
  // scope. Forcing the first reconcile to actually run install or
  // uninstall closes that leakage path.
  let everReconciled = false;

  const applyCurrentConfig = async (): Promise<void> => {
    const config = await readConfigFromSettings(context);
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

  // Settings watcher: rewrite config.json + reconcile MCP entry on
  // any wat321.modelBridge.* change. Cheap (atomic file write +
  // optional CLI call) so doing this every keystroke in settings.json
  // is fine.
  const watcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (
      e.affectsConfiguration(`wat321.${SETTING.modelBridgeEnabled}`) ||
      e.affectsConfiguration(`wat321.${SETTING.modelBridgeLocalEndpoint}`)
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
    })
  );

  return {
    async resetCleanup(): Promise<void> {
      await uninstallModelBridge(logger);
      try {
        await context.secrets.delete(ZEN_API_KEY_SECRET);
      } catch {
        // best-effort
      }
      lastInstallable = false;
    },
    dispose(): void {
      watcher.dispose();
      logger.dispose();
    },
  };
}

/** Install the MCP entry. Skips registration when the `claude` CLI is
 * not available - the user can configure Model Bridge settings before
 * installing Claude Code, in which case the bridge silently waits
 * until both are present. */
async function reconcileInstall(
  context: vscode.ExtensionContext,
  config: ModelBridgeConfig,
  logger: ModelBridgeLogger
): Promise<void> {
  if (!(await isClaudeAvailable())) {
    logger.info(
      "Claude CLI not found on PATH or in the Claude Code VS Code extension; deferring MCP registration until Claude Code is installed."
    );
    return;
  }
  const result = await installModelBridge(context, logger);
  if (!result.ok) {
    logger.error(`install failed: ${result.error ?? "unknown error"}`);
    return;
  }
  const inventory = config.instances
    .map((i) => `${i.id}(${i.kind}${i.apiKeyMissing ? ":no-key" : ""})`)
    .join(", ");
  logger.info(
    `Model Bridge installed (active='${config.activeInstanceId}', inventory=[${inventory}])`
  );
}
