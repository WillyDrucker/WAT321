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

export function activate(context: vscode.ExtensionContext) {
  ctx = createEngineContext();
  registerProviders(ctx);

  const config = vscode.workspace.getConfiguration("wat321");

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
    } else if (!enabled && ctx.providers.isActive("claude")) {
      deactivateExperimentalAutoCompact();
      ctx.providers.deactivate("claude");
      ctx.events.emit("provider.deactivated", { provider: "claude" });
      setProviderActive("claude", false);
      ctx.providers.rebroadcastAll();
    }
  }

  if (e.affectsConfiguration(`wat321.${SETTING.enableCodex}`)) {
    const enabled = config.get<boolean>(SETTING.enableCodex, true);
    if (enabled && !ctx.providers.isActive("codex")) {
      ctx.providers.activate("codex");
      ctx.events.emit("provider.activated", { provider: "codex" });
    } else if (!enabled && ctx.providers.isActive("codex")) {
      ctx.providers.deactivate("codex");
      ctx.events.emit("provider.deactivated", { provider: "codex" });
      setProviderActive("codex", false);
      ctx.providers.rebroadcastAll();
    }
  }

  if (
    e.affectsConfiguration(`wat321.${SETTING.displayMode}`) ||
    e.affectsConfiguration(`wat321.${SETTING.enableHeatmap}`)
  ) {
    ctx.providers.rebroadcastAll();
  }
}
