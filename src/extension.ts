import * as vscode from "vscode";
import {
  activateClaude,
  activateClaudeForceAutoCompact,
  activateCodex,
  deactivateClaudeForceAutoCompact,
  deactivateGroup,
  rebroadcastAll,
  type ActiveGroups,
} from "./bootstrap";
import { registerClaudeForceAutoCompactCommand } from "./WAT321_CLAUDE_FORCE_AUTOCOMPACT/widget";
import { registerClearSettingsCommand } from "./shared/clearSettings";
import { registerWakeCommands } from "./shared/wakeCommands";

/**
 * Top-level entry point. Owns the `activate` / `deactivate` contract
 * plus the `onDidChangeConfiguration` watcher that dynamically brings
 * provider groups up and down when the user toggles settings. All
 * provider-specific wiring lives in `./bootstrap.ts`.
 */

const groups: ActiveGroups = {
  claude: null,
  codex: null,
  claudeForceAutoCompact: null,
};

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("wat321");

  // --- Initial activation based on current settings ---
  if (config.get<boolean>("enableClaude", true)) {
    groups.claude = activateClaude(groups);
  }
  if (config.get<boolean>("enableCodex", true)) {
    groups.codex = activateCodex(groups);
  }
  // Claude Force Auto-Compact is interactive tier - default OFF,
  // requires Claude group to be already active.
  if (config.get<boolean>("enableClaudeForceAutoCompact", false)) {
    groups.claudeForceAutoCompact = activateClaudeForceAutoCompact(
      context,
      groups
    );
  }

  // --- Dynamic enable/disable on settings change ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) =>
      handleConfigChange(e, context)
    )
  );

  // --- Command palette ---
  registerClearSettingsCommand(context);
  // Claude Force Auto-Compact command is registered unconditionally so
  // the palette entry always has a handler. When the feature is
  // disabled, the handler shows an info message pointing to the
  // setting.
  registerClaudeForceAutoCompactCommand(
    context,
    () => groups.claudeForceAutoCompact?.widget ?? null
  );
  // Internal click-to-wake commands for the usage widgets. NOT
  // listed in package.json contributes.commands, so they never
  // appear in the palette - they exist only as status bar click
  // targets when the widget is in the 15-minute fallback state.
  registerWakeCommands(context, groups);
}

export function deactivate() {
  groups.claudeForceAutoCompact = deactivateClaudeForceAutoCompact(
    groups.claudeForceAutoCompact
  );
  groups.claude = deactivateGroup(groups.claude, "claude", groups);
  groups.codex = deactivateGroup(groups.codex, "codex", groups);
}

function handleConfigChange(
  e: vscode.ConfigurationChangeEvent,
  context: vscode.ExtensionContext
): void {
  const config = vscode.workspace.getConfiguration("wat321");

  if (e.affectsConfiguration("wat321.enableClaude")) {
    const enabled = config.get<boolean>("enableClaude", true);
    if (enabled && !groups.claude) {
      groups.claude = activateClaude(groups);
      // If force-auto-compact was enabled before Claude, it couldn't
      // activate because it depends on claudeGroup. Now that Claude
      // is back, bring force-auto-compact up if its setting is on.
      const forceAcEnabled = config.get<boolean>(
        "enableClaudeForceAutoCompact",
        false
      );
      if (forceAcEnabled && !groups.claudeForceAutoCompact) {
        groups.claudeForceAutoCompact = activateClaudeForceAutoCompact(
          context,
          groups
        );
      }
    } else if (!enabled && groups.claude) {
      // Force Auto-Compact depends on Claude - tear it down first.
      groups.claudeForceAutoCompact = deactivateClaudeForceAutoCompact(
        groups.claudeForceAutoCompact
      );
      groups.claude = deactivateGroup(groups.claude, "claude", groups);
    }
  }

  if (e.affectsConfiguration("wat321.enableCodex")) {
    const enabled = config.get<boolean>("enableCodex", true);
    if (enabled && !groups.codex) {
      groups.codex = activateCodex(groups);
    } else if (!enabled && groups.codex) {
      groups.codex = deactivateGroup(groups.codex, "codex", groups);
    }
  }

  if (e.affectsConfiguration("wat321.enableClaudeForceAutoCompact")) {
    const enabled = config.get<boolean>("enableClaudeForceAutoCompact", false);
    if (enabled && !groups.claudeForceAutoCompact && groups.claude) {
      groups.claudeForceAutoCompact = activateClaudeForceAutoCompact(
        context,
        groups
      );
    } else if (!enabled && groups.claudeForceAutoCompact) {
      groups.claudeForceAutoCompact = deactivateClaudeForceAutoCompact(
        groups.claudeForceAutoCompact
      );
    }
  }

  // Re-render all widgets immediately when display settings change.
  if (e.affectsConfiguration("wat321.displayMode")) {
    rebroadcastAll(groups);
  }
}
