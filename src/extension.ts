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
  resetBootstrapCircuit,
  setHostAppName,
} from "./engine/windowsToastProcess";
import { registerClearSettingsCommand } from "./shared/resetSettings";
import { removeLegacyBridge } from "./shared/legacyBridgeRemoval";

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
  // no-op outside Windows paths - safe to call unconditionally.
  if (process.platform === "win32") {
    setHostAppName(vscode.env.appName);
    // Reset the warm-PS circuit breaker when the window regains focus.
    // The warm PowerShell process can be reaped or killed (logoff, AV,
    // task-manager) while the window is in the background, and a few
    // notification events firing during the unfocused stretch can trip
    // the five-bootstrap-fail breaker. Without a reset, the user comes
    // back to a window that silently drops the next five minutes of
    // toasts. Resetting on focus regain pays a single fresh spawn
    // attempt at the moment the user is actually there to notice if
    // notifications are still broken. Underlying problems re-trip the
    // breaker - this just removes the stale-cooldown failure mode.
    let lastFocused = vscode.window.state.focused;
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused && !lastFocused) resetBootstrapCircuit();
        lastFocused = s.focused;
      })
    );
  }

  // One-time removal of the pre-1.6.0 Epic Handshake bridge for
  // upgraders (see legacyBridgeRemoval). Best-effort and idempotent -
  // a fresh install with no prior bridge is a no-op.
  removeLegacyBridge(context);

  ctx = createEngineContext();

  context.subscriptions.push(...registerProviders(ctx));

  const config = vscode.workspace.getConfiguration("wat321");
  lastNotificationMode = config.get<string>(SETTING.notificationsMode, "System Notifications");

  // --- Initial activation based on current settings ---
  // Wrapped per-provider so a throw inside one provider's activation
  // (service constructor, first sync poll, bridge listener) cannot
  // abort the entire extension activation and strand sibling widgets
  // registered-but-invisible.
  if (config.get<boolean>(SETTING.enableClaude, true)) {
    activateProviderSafely(ctx, "claude");
  }
  if (config.get<boolean>(SETTING.enableCodex, true)) {
    activateProviderSafely(ctx, "codex");
  }
  // --- Dynamic enable/disable on settings change ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => handleConfigChange(e))
  );

  // --- Command palette ---
  registerClearSettingsCommand(context, async () => {
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
    e.affectsConfiguration(`wat321.${SETTING.enableHeatmap}`) ||
    e.affectsConfiguration(`wat321.${SETTING.enableTokensPerSecondCounters}`)
  ) {
    ctx.providers.rebroadcastAll();
  }

  // statusBarPriority requires a window reload to take effect because
  // VS Code reads the priority once when each status bar item is
  // created and never recomputes. Passive toast nudges the user - no
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

/** Activate a provider with a try/catch shield. A throw inside the
 * provider's activation factory (service constructor, first sync poll,
 * bridge listener) is surfaced to the user but does not abort the rest
 * of the extension's activate(). Without this shield, sibling widgets
 * register-but-stay-invisible and the user's settings watcher never
 * registers either. */
function activateProviderSafely(ctx: EngineContext, key: ProviderKey): void {
  try {
    ctx.providers.activate(key);
    ctx.events.emit("provider.activated", { provider: key });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showWarningMessage(
      `WAT321 ${key} activation failed; other widgets continue working. (${msg})`
    );
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

