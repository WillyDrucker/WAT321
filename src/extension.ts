import * as vscode from "vscode";
import {
  activateExperimentalAutoCompact,
  deactivateExperimentalAutoCompact,
  getExperimentalAutoCompactService,
  registerProviders,
} from "./bootstrap";
import type { EngineContext } from "./engine/engineContext";
import { createEngineContext } from "./engine/engineContext";
import { registerHealthCommand } from "./engine/healthCommand";
import { SETTING } from "./engine/settingsKeys";
import { registerClearSettingsCommand } from "./shared/clearSettings";
import { setProviderActive } from "./shared/displayMode";
import { registerCancelExperimentalAutoCompactCommand } from "./WAT321_EXPERIMENTAL_AUTOCOMPACT/service";

/**
 * Top-level entry point. Creates the engine context, registers
 * providers, and wires the configuration change handler that
 * dynamically brings provider groups up and down.
 */

let ctx: EngineContext | null = null;
let lastNotificationMode = "Auto";

export function activate(context: vscode.ExtensionContext) {
  ctx = createEngineContext();
  context.subscriptions.push(...registerProviders(ctx));

  const config = vscode.workspace.getConfiguration("wat321");
  lastNotificationMode = config.get<string>(SETTING.notificationsMode, "Auto");

  // --- Initial activation based on current settings ---
  if (config.get<boolean>(SETTING.enableClaude, true)) {
    ctx.providers.activate("claude");
    ctx.events.emit("provider.activated", { provider: "claude" });
  }
  if (config.get<boolean>(SETTING.enableCodex, true)) {
    ctx.providers.activate("codex");
    ctx.events.emit("provider.activated", { provider: "codex" });
  }
  if (ctx.providers.isActive("claude")) {
    activateExperimentalAutoCompact(ctx);
  }

  // --- Dynamic enable/disable on settings change ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => handleConfigChange(e))
  );

  // --- Command palette ---
  registerClearSettingsCommand(context, () => {
    ctx?.providers.resetAllKickstartEscalation();
    ctx?.events.emit("engine.reset", {});
  });
  registerCancelExperimentalAutoCompactCommand(
    context,
    () => getExperimentalAutoCompactService()
  );
  registerHealthCommand(context, () => ctx);
}

export function deactivate() {
  if (!ctx) return;
  deactivateExperimentalAutoCompact();
  ctx.providers.disposeAll();
  ctx.events.clear();
}

function handleConfigChange(e: vscode.ConfigurationChangeEvent): void {
  if (!ctx) return;
  const config = vscode.workspace.getConfiguration("wat321");

  if (e.affectsConfiguration(`wat321.${SETTING.enableClaude}`)) {
    const enabled = config.get<boolean>(SETTING.enableClaude, true);
    if (enabled && !ctx.providers.isActive("claude")) {
      ctx.providers.activate("claude");
      ctx.events.emit("provider.activated", { provider: "claude" });
      activateExperimentalAutoCompact(ctx);
      // Restore notification checkbox when provider comes back on,
      // unless notifications are Off entirely.
      if (lastNotificationMode !== "Off") {
        safeUpdate(config, SETTING.notificationsClaude, true);
      }
    } else if (!enabled && ctx.providers.isActive("claude")) {
      deactivateExperimentalAutoCompact();
      ctx.providers.deactivate("claude");
      ctx.events.emit("provider.deactivated", { provider: "claude" });
      setProviderActive("claude", false);
      ctx.providers.rebroadcastAll();
      safeUpdate(config, SETTING.notificationsClaude, false);
    }
  }

  if (e.affectsConfiguration(`wat321.${SETTING.enableCodex}`)) {
    const enabled = config.get<boolean>(SETTING.enableCodex, true);
    if (enabled && !ctx.providers.isActive("codex")) {
      ctx.providers.activate("codex");
      ctx.events.emit("provider.activated", { provider: "codex" });
      if (lastNotificationMode !== "Off") {
        safeUpdate(config, SETTING.notificationsCodex, true);
      }
    } else if (!enabled && ctx.providers.isActive("codex")) {
      ctx.providers.deactivate("codex");
      ctx.events.emit("provider.deactivated", { provider: "codex" });
      setProviderActive("codex", false);
      ctx.providers.rebroadcastAll();
      safeUpdate(config, SETTING.notificationsCodex, false);
    }
  }

  // Reject notification checkbox if the provider is disabled.
  // VS Code settings UI can't conditionally disable a checkbox,
  // so we enforce the invariant reactively: if a user checks
  // "notify for Codex" while Codex is off, we immediately uncheck
  // it. The Settings UI won't repaint the checkbox in place (known
  // VS Code rendering quirk) but the config value is correct.
  if (e.affectsConfiguration(`wat321.${SETTING.notificationsClaude}`)) {
    if (
      config.get<boolean>(SETTING.notificationsClaude, true) &&
      !config.get<boolean>(SETTING.enableClaude, true)
    ) {
      safeUpdate(config, SETTING.notificationsClaude, false);
    }
  }
  if (e.affectsConfiguration(`wat321.${SETTING.notificationsCodex}`)) {
    if (
      config.get<boolean>(SETTING.notificationsCodex, true) &&
      !config.get<boolean>(SETTING.enableCodex, true)
    ) {
      safeUpdate(config, SETTING.notificationsCodex, false);
    }
  }

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
    const mode = config.get<string>(SETTING.notificationsMode, "Auto");
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
