import * as vscode from "vscode";
import { registerProviders } from "./bootstrap";
import { setProviderActive } from "./engine/displayMode";
import type { ProviderKey } from "./engine/contracts";
import type { EngineContext } from "./engine/engineContext";
import { createEngineContext } from "./engine/engineContext";
import { registerHealthCommand } from "./engine/healthCommand";
import { SETTING } from "./engine/settingsKeys";
import {
  dispose as disposeToastProcess,
  setHostAppName,
} from "./engine/windowsToastProcess";
import { registerClearSettingsCommand } from "./shared/resetSettings";
import { workspaceId } from "./shared/wat321Paths";
import {
  registerAutoCreateOpenCodeS1,
  registerBridgeConfigWriter,
  registerUnifiedBridgeCommands,
} from "./WAT321_MCP_SERVER";
import { activateEpicHandshake } from "./WAT321_EPIC_HANDSHAKE";
import { activateOpenCodeRoutes } from "./WAT321_OPENCODE_ROUTES";

/**
 * Top-level entry point. Creates the engine context, registers
 * providers, and wires the configuration change handler that
 * dynamically brings provider groups up and down.
 */

let ctx: EngineContext | null = null;
let lastNotificationMode = "System Notifications";

export function activate(context: vscode.ExtensionContext) {
  // Hand the host app name to the warm PowerShell process so it can
  // resolve the correct AppUserModelID via `Get-StartApps` at its
  // bootstrap. This is the only hook the toast module needs - AUMID
  // discovery happens in-process, no second PowerShell spawn. An
  // unregistered AUMID causes Windows to silently discard the toast
  // with zero logging, so getting this right matters across every VS
  // Code fork (Insiders, VSCodium, Cursor, Windsurf). Setter is a
  // no-op outside Windows paths; safe to call unconditionally.
  if (process.platform === "win32") {
    setHostAppName(vscode.env.appName);
  }

  // Set WAT321_WORKSPACE_ID on the extension host's process env so any
  // subprocess this extension spawns (the OpenCode harness, the Codex
  // bridge channel, the warm PowerShell toast) inherits the same wsId
  // the path helpers use. Claude Code's MCP layer doesn't read this -
  // the installer injects WAT321_WORKSPACE_ID separately via the MCP
  // entry's --env. Both surfaces resolve to the same value because
  // workspaceId() is deterministic.
  process.env.WAT321_WORKSPACE_ID = workspaceId();

  ctx = createEngineContext();

  // Migrate legacy `wat321.sessionTokens.compact: true` onto the
  // displayMode enum value "Full + Compact"; the workspace-scope-heal
  // sweep then strips the orphan key. Idempotent and best-effort.
  void migrateSessionTokensCompact();

  // Migrate legacy modelBridge.enabled -> enableOpenCode and
  // modelBridge.localEndpoint -> localEndpoint. Reads any explicit
  // value at the old keys and copies to the new keys; the workspace-
  // scope-heal sweep strips the source on the same activate.
  // Idempotent.
  void migrateModelBridgeKeys();

  // Bridge config writer maintains the per-client
  // `~/.wat321/clients/<wsId>/bridge/config.json` so the unified MCP
  // server can read enabled-target flags at startup. Cheap on activate,
  // cheap on settings change.
  registerBridgeConfigWriter(context);
  registerUnifiedBridgeCommands(context);
  registerAutoCreateOpenCodeS1(context);

  // Epic Handshake tier activates first so its bridge-stage
  // coordinator exists by the time the Claude / Codex session-token
  // widgets construct in registerProviders. The session-token widgets
  // depend on the bridge stage reader for their prefix animations
  // (debug-disconnect ceremony, stage glyph cycle, etc.).
  const epicHandshake = activateEpicHandshake(context, ctx.events);
  context.subscriptions.push(epicHandshake);

  // OpenCode Routes tier (local + cloud LLMs). Independent of Epic
  // Handshake; the unified `wat321` MCP server (registered by the MCP
  // Server tier) handles dispatch for both. Wrapped in try/catch so a
  // fatal bug in this tier never takes down the core Claude / Codex
  // widgets - OpenCode Routes is opt-in, the usage widgets are not.
  let modelBridge: { resetCleanup: () => Promise<void>; dispose: () => void } | null = null;
  try {
    modelBridge = activateOpenCodeRoutes(context);
    context.subscriptions.push(modelBridge);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showWarningMessage(
      `WAT321 OpenCode Routes failed to activate; usage widgets continue working. (${msg})`
    );
  }

  context.subscriptions.push(
    ...registerProviders(ctx, epicHandshake.bridgeStage)
  );

  const config = vscode.workspace.getConfiguration("wat321");
  lastNotificationMode = config.get<string>(SETTING.notificationsMode, "System Notifications");

  // --- Initial activation based on current settings ---
  if (config.get<boolean>(SETTING.enableClaude, true)) {
    ctx.providers.activate("claude");
    ctx.events.emit("provider.activated", { provider: "claude" });
  }
  if (config.get<boolean>(SETTING.enableCodex, true)) {
    ctx.providers.activate("codex");
    ctx.events.emit("provider.activated", { provider: "codex" });
  }
  // --- Dynamic enable/disable on settings change ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => handleConfigChange(e))
  );

  // --- Command palette ---
  // Reset hook awaits Epic Handshake cleanup (MCP uninstall from
  // ~/.claude/settings.json + globalState key removal) before the
  // disk wipe runs, so a prior MCP entry cannot survive as a zombie.
  registerClearSettingsCommand(context, async () => {
    ctx?.providers.resetAllKickstartEscalation();
    ctx?.providers.resetAllTokenServices();
    ctx?.events.emit("engine.reset", {});
    await epicHandshake.resetCleanup();
    if (modelBridge) await modelBridge.resetCleanup();
    // Sweep the unified bridge's MCP entry + pre-allowed tool list
    // (mcp__wat321__wat321_ask, etc.) from ~/.claude/settings.json. EH's
    // resetCleanup removes the legacy `wat321` entry, but if the user
    // ever ran the unified install command the entry got rewritten to
    // point at ~/.wat321/bridge/bin/channel.mjs and the unified tool
    // names were added to the allowlist. Reset is "factory clean" - both
    // surfaces have to go. Idempotent - succeeds even if neither was
    // ever installed.
    try {
      const { uninstallUnifiedBridge } = await import("./WAT321_MCP_SERVER/installer");
      await uninstallUnifiedBridge();
    } catch {
      // best-effort - reset continues regardless
    }
  });
  registerHealthCommand(context, () => ctx);
}

export function deactivate() {
  disposeToastProcess();
  if (!ctx) return;
  ctx.providers.disposeAll();
  ctx.events.clear();
}

function handleConfigChange(e: vscode.ConfigurationChangeEvent): void {
  if (!ctx) return;
  const config = vscode.workspace.getConfiguration("wat321");

  toggleProvider(e, config, "claude", SETTING.enableClaude, SETTING.notificationsClaude);
  toggleProvider(e, config, "codex", SETTING.enableCodex, SETTING.notificationsCodex);

  // Reject notification checkbox if the provider is disabled.
  // VS Code settings UI can't conditionally disable a checkbox,
  // so we enforce the invariant reactively. The Settings UI won't
  // repaint the checkbox in place (known VS Code rendering quirk)
  // but the config value is correct.
  rejectNotificationIfDisabled(e, config, SETTING.notificationsClaude, SETTING.enableClaude);
  rejectNotificationIfDisabled(e, config, SETTING.notificationsCodex, SETTING.enableCodex);

  if (
    e.affectsConfiguration(`wat321.${SETTING.displayMode}`) ||
    e.affectsConfiguration(`wat321.${SETTING.enableHeatmap}`)
  ) {
    ctx.providers.rebroadcastAll();
  }

  // statusBarPriority requires a window reload to take effect because
  // VS Code reads the priority once when each status bar item is
  // created and never recomputes. Passive toast nudges the user; no
  // modal, no action button (matches the rest of WAT321's voice).
  if (e.affectsConfiguration(`wat321.${SETTING.statusBarPriority}`)) {
    void vscode.window.showInformationMessage(
      "Status bar priority changed. Reload the window to apply the new ordering."
    );
  }

  // Notification mode changed: Off unchecks both provider
  // checkboxes. Switching between active modes (Auto/System/In-App)
  // does NOT touch per-provider checkboxes - those are the user's
  // independent preference. Only the Off->active transition restores
  // defaults so the user doesn't have to manually re-check after
  // turning notifications back on.
  if (e.affectsConfiguration(`wat321.${SETTING.notificationsMode}`)) {
    const mode = config.get<string>(SETTING.notificationsMode, "System Notifications");
    if (mode === "Off") {
      lastNotificationMode = "Off";
      safeUpdate(config, SETTING.notificationsClaude, false);
      safeUpdate(config, SETTING.notificationsCodex, false);
    } else if (lastNotificationMode === "Off") {
      // Transitioning from Off to an active mode - restore defaults
      lastNotificationMode = mode;
      safeUpdate(
        config,
        SETTING.notificationsClaude,
        config.get<boolean>(SETTING.enableClaude, true)
      );
      safeUpdate(
        config,
        SETTING.notificationsCodex,
        config.get<boolean>(SETTING.enableCodex, true)
      );
    } else {
      lastNotificationMode = mode;
    }
  }
}

/** Handle enable/disable toggle for a single provider. Activates or
 * deactivates the provider group, emits lifecycle events, and syncs
 * the notification checkbox. */
function toggleProvider(
  e: vscode.ConfigurationChangeEvent,
  config: vscode.WorkspaceConfiguration,
  key: ProviderKey,
  enableKey: string,
  notificationKey: string
): void {
  if (!ctx || !e.affectsConfiguration(`wat321.${enableKey}`)) return;
  const enabled = config.get<boolean>(enableKey, true);
  if (enabled && !ctx.providers.isActive(key)) {
    ctx.providers.activate(key);
    ctx.events.emit("provider.activated", { provider: key });
    if (lastNotificationMode !== "Off") {
      safeUpdate(config, notificationKey, true);
    }
  } else if (!enabled && ctx.providers.isActive(key)) {
    ctx.providers.deactivate(key);
    ctx.events.emit("provider.deactivated", { provider: key });
    setProviderActive(key, false);
    ctx.providers.rebroadcastAll();
    safeUpdate(config, notificationKey, false);
  }
}

/** Uncheck a notification toggle if its provider is disabled. */
function rejectNotificationIfDisabled(
  e: vscode.ConfigurationChangeEvent,
  config: vscode.WorkspaceConfiguration,
  notificationKey: string,
  enableKey: string
): void {
  if (!e.affectsConfiguration(`wat321.${notificationKey}`)) return;
  if (
    config.get<boolean>(notificationKey, true) &&
    !config.get<boolean>(enableKey, true)
  ) {
    safeUpdate(config, notificationKey, false);
  }
}

/** Write a setting at Global scope, swallowing errors. */
async function safeUpdate(
  config: vscode.WorkspaceConfiguration,
  key: string,
  value: unknown
): Promise<void> {
  try {
    await config.update(key, value, vscode.ConfigurationTarget.Global);
  } catch {
    // read-only or scope rejected
  }
}

/** Fold legacy `sessionTokens.compact: true` into the displayMode
 * enum value "Full + Compact". Skips when the current displayMode is
 * already set to a non-Auto/non-Full value (Compact, Minimal) - those
 * users had no effect from the old boolean and shouldn't be flipped
 * to a different visible mode by the migration. Skips when the user
 * is already on "Full + Compact" or doesn't have the legacy boolean
 * set. Best-effort; the workspace-scope-heal sweep strips the source
 * key on the same activate. */
async function migrateSessionTokensCompact(): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration("wat321");
    const inspect = config.inspect<boolean>("sessionTokens.compact");
    const compact =
      inspect?.globalValue === true || inspect?.workspaceValue === true;
    if (!compact) return;
    const currentMode = config.get<string>(SETTING.displayMode, "Auto");
    if (currentMode === "Auto" || currentMode === "Full") {
      await config.update(
        SETTING.displayMode,
        "Full + Compact",
        vscode.ConfigurationTarget.Global
      );
    }
    // Source key removal happens via workspaceScopeHeal's APPLICATION_SCOPE_KEYS
    // sweep (also catches workspace-scope copies) - no need to update here.
  } catch {
    // best-effort - leaving both keys present is recoverable from the UI
  }
}

/** Rename `modelBridge.enabled` -> `enableOpenCode` and
 * `modelBridge.localEndpoint` -> `localEndpoint`. The "Model Bridge"
 * naming was internal; the user-facing settings now live under the
 * top-level OpenCode section with cleaner labels.
 *
 * Migration semantics: copy any explicit value at the old key onto
 * the new key, only when the new key has no explicit value of its
 * own (so a user who already set the new key during a prior partial
 * upgrade isn't overwritten). Source key removal happens via the
 * workspace-scope-heal legacy sweep on the same activate. */
async function migrateModelBridgeKeys(): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration("wat321");

    const oldEnabled = config.inspect<boolean>("modelBridge.enabled");
    const newEnabled = config.inspect<boolean>("enableOpenCode");
    if (
      newEnabled?.globalValue === undefined &&
      newEnabled?.workspaceValue === undefined &&
      (oldEnabled?.globalValue !== undefined ||
        oldEnabled?.workspaceValue !== undefined)
    ) {
      const value = oldEnabled.globalValue ?? oldEnabled.workspaceValue;
      if (typeof value === "boolean") {
        await config.update(
          SETTING.enableOpenCode,
          value,
          vscode.ConfigurationTarget.Global
        );
      }
    }

    const oldEndpoint = config.inspect<string>("modelBridge.localEndpoint");
    const newEndpoint = config.inspect<string>("localEndpoint");
    if (
      newEndpoint?.globalValue === undefined &&
      newEndpoint?.workspaceValue === undefined &&
      (oldEndpoint?.globalValue !== undefined ||
        oldEndpoint?.workspaceValue !== undefined)
    ) {
      const value = oldEndpoint.globalValue ?? oldEndpoint.workspaceValue;
      if (typeof value === "string") {
        await config.update(
          SETTING.localEndpoint,
          value,
          vscode.ConfigurationTarget.Global
        );
      }
    }
  } catch {
    // best-effort - source keys remain readable until the heal sweep runs
  }
}
