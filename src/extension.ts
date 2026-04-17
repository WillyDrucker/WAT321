import * as vscode from "vscode";
import { registerProviders } from "./bootstrap";
import { setProviderActive } from "./engine/displayMode";
import type { ProviderKey } from "./engine/contracts";
import type { EngineContext } from "./engine/engineContext";
import { createEngineContext } from "./engine/engineContext";
import { registerHealthCommand } from "./engine/healthCommand";
import { SETTING } from "./engine/settingsKeys";
import { dispose as disposeToastProcess } from "./engine/windowsToastProcess";
import { registerClearSettingsCommand } from "./shared/resetSettings";

/**
 * Top-level entry point. Creates the engine context, registers
 * providers, and wires the configuration change handler that
 * dynamically brings provider groups up and down.
 */

let ctx: EngineContext | null = null;
let lastNotificationMode = "System Notifications";

export function activate(context: vscode.ExtensionContext) {
  ctx = createEngineContext();
  context.subscriptions.push(...registerProviders(ctx));

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
  registerClearSettingsCommand(context, () => {
    ctx?.providers.resetAllKickstartEscalation();
    ctx?.providers.resetAllTokenServices();
    ctx?.events.emit("engine.reset", {});
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
