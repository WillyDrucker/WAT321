import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";
import { writeFileAtomic } from "../shared/fs/atomicWrite";

/**
 * WAT321 Bridge - extension-side scaffolding for the unified MCP
 * server (v1.4.1+).
 *
 * The unified `channel.mjs` reads enabled-feature flags from
 * `~/.wat321/bridge/config.json` to decide which `target` values to
 * advertise. This module owns writing that file on activate and on
 * settings change, plus exposing the bridge directory layout for
 * future wiring (installer, session alias map, etc).
 *
 * Status: scaffolding only. Installer not yet wired - the legacy
 * Epic Handshake + Model Bridge servers still register independently
 * until the handler-port milestones land. Once the migration is
 * complete, this tier owns:
 *
 *   - install/uninstall (single `claude mcp add wat321` entry)
 *   - legacy-sweep (remove `wat321-model-bridge` and old `wat321`)
 *   - tool allowlist write
 *   - session alias map storage
 *
 * See WDDOCS/WAT321_V141_MCP_MERGE_PLAN.md for the full migration
 * order.
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

  return {
    enabled: {
      codex: codexAvailable && modeMask.codex,
      opencode: opencodeAvailable && modeMask.opencode,
      local: localAvailable && modeMask.local,
    },
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

/** Re-run the unified install on every activate when useUnified=true.
 * Idempotent: claude mcp add is a no-op when the entry already exists
 * with the same arguments. The activate-time call ensures a user who
 * upgrades the .vsix gets fresh script extracts (channel.mjs, codex.mjs,
 * opencode.mjs) without manually re-running the install command. */
async function autoInstallIfEnabled(
  context: vscode.ExtensionContext
): Promise<void> {
  const useUnified = vscode.workspace
    .getConfiguration("wat321")
    .get<boolean>(SETTING.bridgeUseUnified, false);
  if (!useUnified) return;
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
  });
  context.subscriptions.push(subscription);
  return subscription;
}
