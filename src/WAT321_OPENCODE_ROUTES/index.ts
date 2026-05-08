import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";
import {
  isConfigInstallable,
  readConfigFromSettings,
  writeConfigFile,
} from "./config";
import { MODEL_BRIDGE_DIR } from "./constants";
import { createOpenCodeRoutesLogger } from "./outputChannel";
import { createOpenCodeManager } from "../WAT321_OPENCODE_HARNESS";
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
    const enabled = cfg.get<boolean>(SETTING.enableOpenCode, false);
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

    const installable = isConfigInstallable(config);
    if (everReconciled && installable === lastInstallable) {
      return;
    }
    lastInstallable = installable;
    everReconciled = true;

    // OPENCODE_ROUTES owns no MCP entry of its own. The unified
    // `wat321` server installed by WAT321_MCP_SERVER on Epic Handshake
    // enable handles all dispatch and sweeps every legacy entry name
    // there. This tier's reconcile only writes its own config / harness
    // state; nothing here touches Claude's MCP allowlist.
    void installable;
  };

  // Apply once at activate so the config file exists before
  // channel.mjs is ever spawned. The MCP entry only registers if
  // settings are complete enough to call out.
  void applyCurrentConfig();

  // Track OpenCode Routes enable transitions so we toast the user on
  // off->on (with the same "what to do next" voice as Epic Handshake's
  // enable toast) and on on->off (matches EH "disabled." toast).
  // Initialized from current setting at activate so a settings event
  // fired during startup-flush doesn't get treated as a transition.
  let lastEnabledState = vscode.workspace
    .getConfiguration("wat321")
    .get<boolean>(SETTING.enableOpenCode, false);

  // Settings watcher: rewrite config.json + reconcile MCP entry on
  // any wat321.modelBridge.* change. Cheap (atomic file write +
  // optional CLI call) so doing this every keystroke in settings.json
  // is fine.
  const watcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (
      e.affectsConfiguration(`wat321.${SETTING.enableOpenCode}`) ||
      e.affectsConfiguration(`wat321.${SETTING.localEndpoint}`)
    ) {
      const nowEnabled = vscode.workspace
        .getConfiguration("wat321")
        .get<boolean>(SETTING.enableOpenCode, false);
      if (nowEnabled !== lastEnabledState) {
        if (nowEnabled) {
          void vscode.window.showInformationMessage(
            "OpenCode Routes is ready. Send prompts to OpenCode/Local LLM using natural language like \"Ask Big Pickle to ...\" or \"Ask the local LLM ...\" to use. New Claude sessions pick up the new tools automatically; active sessions need to be restarted. Note: resuming existing Claude sessions counts toward usage."
          );
        } else {
          void vscode.window.showInformationMessage("OpenCode Routes disabled.");
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
      lastInstallable = false;
    },
    dispose(): void {
      watcher.dispose();
      void openCodeManager.dispose();
      logger.dispose();
    },
  };
}

