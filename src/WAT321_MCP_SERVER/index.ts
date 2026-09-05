import { existsSync, mkdirSync } from "node:fs";
import { BRIDGE_CONFIG_PATH } from "../shared/bridge/bridgeConfig";
import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";
import { writeFileAtomic } from "../engine/fs/atomicWrite";
import { bridgeStateDir } from "../engine/wat321Paths";

/**
 * WAT321 Bridge - extension-side ownership of the unified MCP server.
 *
 * The unified `channel.mjs` reads enabled-feature flags from the
 * per-client bridge state dir to decide which targets and tools to
 * advertise to Claude. This module owns:
 *
 *   - bridge config writer (refreshes on activate + settings change)
 *   - auto-install on Epic Handshake enable (idempotent)
 *   - session-alias map storage at
 *     `~/.wat321/clients/<wsId>/bridge/session-aliases.json`
 *   - project-name stamp for standardized session display labels
 *   - auto-create OpenCode S1 session on OpenCode Routes enable
 *
 * Epic Handshake's enabled flag is the single switch for the bridge.
 * Disabling EH sweeps the unified MCP entry - enabling installs it.
 */

const BRIDGE_DIR = bridgeStateDir();

interface BridgeConfig {
  enabled: {
    codex: boolean;
    opencode: boolean;
    local: boolean;
  };
  /** Workspace folder name for the active VS Code window. Used by
   * the unified bridge handlers and by the EH session-management
   * pickers to label sessions as `<projectName> Epic Handshake
   * Claude-to-<Target> S<n>` so the user sees a deterministic title
   * in every menu surface instead of OpenCode's auto-generated slug. */
  projectName: string;
}

/** Read live setting state and project it onto the unified bridge
 * config shape. Each target gates on its own master switch:
 *
 *   - codex: `epicHandshake.enabled`
 *   - opencode: `enableOpenCode`
 *   - local: `enableOpenCode` AND non-empty `localEndpoint`
 *
 * Targets whose CLI is not installed gracefully degrade at the router
 * (handlers return a clean "not installed" error rather than crashing).
 * The unified MCP server reads this snapshot at every dispatch to
 * honor the disabled-target gate. */
function snapshotConfig(): BridgeConfig {
  const config = vscode.workspace.getConfiguration("wat321");
  const codexAvailable = config.get<boolean>(SETTING.epicHandshakeEnabled, false);
  const openCodeEnabled = config.get<boolean>(SETTING.enableOpenCode, false);
  const localEndpoint = config
    .get<string>(SETTING.localEndpoint, "")
    .trim();
  const opencodeAvailable = openCodeEnabled;
  const localAvailable = openCodeEnabled && localEndpoint.length > 0;

  // Workspace folder name when one is open, "Workspace" as a generic
  // fallback when the user has VS Code open with no folder. The bridge
  // tier and EH menus stamp this on session display labels so users
  // see e.g. "WAT321 Epic Handshake Claude-to-Local S1" rather than
  // OpenCode's auto-generated slug.
  const folder = vscode.workspace.workspaceFolders?.[0];
  const projectName = folder?.name?.trim() || "Workspace";

  return {
    enabled: {
      codex: codexAvailable,
      opencode: opencodeAvailable,
      local: localAvailable,
    },
    projectName,
  };
}

/** Atomic write of the current setting snapshot. Called on activate
 * and from the settings-change watcher. Failure is logged but never
 * thrown - the unified channel.mjs treats a missing config as
 * "all-disabled" so a write failure degrades gracefully. */
function writeBridgeConfig(): void {
  try {
    if (!existsSync(BRIDGE_DIR)) {
      mkdirSync(BRIDGE_DIR, { recursive: true });
    }
    const snapshot = snapshotConfig();
    writeFileAtomic(BRIDGE_CONFIG_PATH, JSON.stringify(snapshot, null, 2));
  } catch {
    // best-effort - missing config falls back to all-disabled
  }
}

/** Re-run the unified install on every activate when Epic Handshake
 * is enabled. Idempotent: `claude mcp add` is a no-op when the entry
 * already exists with the same arguments. The activate-time call
 * ensures a user who upgrades the .vsix gets fresh script extracts
 * (channel.mjs and its codex/ and opencode/ handlers) without manually toggling
 * EH off and back on. EH-disabled state skips - the unified server
 * has nothing useful to expose without a dispatcher. */
async function autoInstallIfEnabled(
  context: vscode.ExtensionContext
): Promise<void> {
  const ehEnabled = vscode.workspace
    .getConfiguration("wat321")
    .get<boolean>(SETTING.epicHandshakeEnabled, false);
  if (!ehEnabled) return;
  try {
    const { installUnifiedBridge } = await import("./installer");
    await installUnifiedBridge(context);
  } catch {
    // best-effort - install failure surfaces in the bridge output channel
  }
}

/** Wire the activate-time write + settings-change watcher. Returns a
 * Disposable so extension.ts can register it for cleanup on
 * deactivate. The watcher only fires when one of the three relevant
 * keys changes - other wat321.* settings are ignored. */
export function registerBridgeConfigWriter(
  context: vscode.ExtensionContext
): vscode.Disposable {
  writeBridgeConfig();
  void autoInstallIfEnabled(context);
  const subscription = vscode.workspace.onDidChangeConfiguration((e) => {
    if (
      e.affectsConfiguration(`wat321.${SETTING.epicHandshakeEnabled}`) ||
      e.affectsConfiguration(`wat321.${SETTING.enableOpenCode}`) ||
      e.affectsConfiguration(`wat321.${SETTING.localEndpoint}`)
    ) {
      writeBridgeConfig();
    }
  });
  // Workspace-folder add/remove changes the projectName we stamp on
  // session display labels - rewrite config so the next session create
  // picks up the new name without a window reload.
  const folderSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    writeBridgeConfig();
  });
  context.subscriptions.push(subscription);
  context.subscriptions.push(folderSub);
  return subscription;
}
