import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";
import { writeFileAtomic } from "../shared/fs/atomicWrite";

/**
 * WAT321 Bridge - extension-side ownership of the unified MCP server.
 *
 * The unified `channel.mjs` reads enabled-feature flags from
 * `~/.wat321/bridge/config.json` to decide which targets and tools to
 * advertise to Claude. This module owns:
 *
 *   - bridge config writer (refreshes on activate + settings change)
 *   - auto-install on Epic Handshake enable (idempotent)
 *   - session-alias map storage at `~/.wat321/bridge/session-aliases.json`
 *   - project-name stamp for standardized session display labels
 *   - auto-create OpenCode S1 session on Model Bridge enable
 *
 * Epic Handshake's enabled flag is the single switch for the bridge.
 * Disabling EH sweeps the unified MCP entry; enabling installs it.
 */

export { installUnifiedBridge, registerUnifiedBridgeCommands } from "./installer";
export { registerAutoCreateOpenCodeS1 } from "./autoCreateSession";

export const BRIDGE_DIR = join(homedir(), ".wat321", "bridge");
export const BRIDGE_CONFIG_PATH = join(BRIDGE_DIR, "config.json");

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
 * config shape. Two layers of gating:
 *
 *   1. Master availability: codex requires `epicHandshake.enabled`,
 *      opencode requires `modelBridge.enabled`, local additionally
 *      requires a non-empty `modelBridge.localEndpoint`. Targets that
 *      aren't installed never appear regardless of mode.
 *   2. Bridge mode narrowing: `epicHandshake.bridgeMode` further
 *      filters which available targets to expose. "Codex Only" with
 *      both EH and MB enabled still drops opencode/local from the
 *      unified MCP server's tool surface, saving Claude's system-
 *      prompt tokens.
 *
 * The dropdown intersects with master availability via AND - mode
 * "OpenCode Only" with Model Bridge disabled still produces all-
 * disabled (the master switch wins). */
function snapshotConfig(): BridgeConfig {
  const config = vscode.workspace.getConfiguration("wat321");
  const codexAvailable = config.get<boolean>(SETTING.epicHandshakeEnabled, false);
  const modelBridge = config.get<boolean>(SETTING.modelBridgeEnabled, false);
  const localEndpoint = config
    .get<string>(SETTING.modelBridgeLocalEndpoint, "")
    .trim();
  const opencodeAvailable = modelBridge;
  const localAvailable = modelBridge && localEndpoint.length > 0;

  const mode = config.get<string>(
    SETTING.epicHandshakeBridgeMode,
    "Auto (All)"
  );
  const modeMask = bridgeModeMask(mode);

  // Workspace folder name when one is open, "Workspace" as a generic
  // fallback when the user has VS Code open with no folder. The bridge
  // tier and EH menus stamp this on session display labels so users
  // see e.g. "WAT321 Epic Handshake Claude-to-Local S1" rather than
  // OpenCode's auto-generated slug.
  const folder = vscode.workspace.workspaceFolders?.[0];
  const projectName = folder?.name?.trim() || "Workspace";

  return {
    enabled: {
      codex: codexAvailable && modeMask.codex,
      opencode: opencodeAvailable && modeMask.opencode,
      local: localAvailable && modeMask.local,
    },
    projectName,
  };
}

interface BridgeModeMask {
  codex: boolean;
  opencode: boolean;
  local: boolean;
}

/** Translate the user-facing bridgeMode enum into a per-target mask.
 * Unknown values fall back to Auto (All) so a typo doesn't silently
 * disable everything. */
function bridgeModeMask(mode: string): BridgeModeMask {
  switch (mode) {
    case "Codex Only":
      return { codex: true, opencode: false, local: false };
    case "OpenCode Only":
      return { codex: false, opencode: true, local: false };
    case "Local LLM Only":
      return { codex: false, opencode: false, local: true };
    case "Codex + OpenCode":
      return { codex: true, opencode: true, local: false };
    default:
      // Auto (All) and any unrecognized value: expose every available target.
      return { codex: true, opencode: true, local: true };
  }
}

/** Atomic write of the current setting snapshot. Called on activate
 * and from the settings-change watcher. Failure is logged but never
 * thrown - the unified channel.mjs treats a missing config as
 * "all-disabled" so a write failure degrades gracefully. */
export function writeBridgeConfig(): void {
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
 * (channel.mjs, codex.mjs, opencode.mjs) without manually toggling
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
      e.affectsConfiguration(`wat321.${SETTING.epicHandshakeBridgeMode}`) ||
      e.affectsConfiguration(`wat321.${SETTING.modelBridgeEnabled}`) ||
      e.affectsConfiguration(`wat321.${SETTING.modelBridgeLocalEndpoint}`)
    ) {
      writeBridgeConfig();
    }
    // Bridge mode change requires a window reload because Claude Code
    // snapshots MCP tool registrations at connection time - the new
    // target enum doesn't propagate to active sessions until reload.
    // Passive toast informs without forcing a modal; the user reloads
    // when convenient. Matches the EH enable/disable toast voice.
    if (e.affectsConfiguration(`wat321.${SETTING.epicHandshakeBridgeMode}`)) {
      void vscode.window.showInformationMessage(
        "Bridge mode changed. Reload the window to update the MCP tool surface for active Claude sessions."
      );
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
