import * as vscode from "vscode";
import {
  activateClaude,
  activateCodex,
  activateExperimentalAutoCompact,
  deactivateExperimentalAutoCompact,
  deactivateGroup,
  rebroadcastAll,
  type ActiveGroups,
} from "./bootstrap";
import { registerClearSettingsCommand } from "./shared/clearSettings";
import { registerCancelExperimentalAutoCompactCommand } from "./WAT321_EXPERIMENTAL_AUTOCOMPACT/service";

/**
 * Top-level entry point. Owns the `activate` / `deactivate` contract
 * plus the `onDidChangeConfiguration` watcher that dynamically brings
 * provider groups up and down when the user toggles settings. All
 * provider-specific wiring lives in `./bootstrap.ts`.
 */

const groups: ActiveGroups = {
  claude: null,
  codex: null,
  experimentalAutoCompact: null,
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
  // Experimental Force Claude Auto-Compact: always activated when
  // Claude is active. The service itself owns the config listener
  // and arms/disarms based on the experimental setting. No widget,
  // no command to register, no consent to gate.
  if (groups.claude) {
    groups.experimentalAutoCompact = activateExperimentalAutoCompact(groups);
  }

  // --- Dynamic enable/disable on settings change ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => handleConfigChange(e))
  );

  // --- Command palette ---
  // Pass a hook that clears the kickstart escalation ladder on both
  // running usage services when the user runs Reset WAT321. The
  // disk wipe in clearSettings cannot reach in-memory service state,
  // so the hook is how a user trapped in a sustained outage can
  // manually get back to the responsive fresh-park cadence. Gating
  // is preserved - the hook only zeroes counters and shrinks the
  // poll interval, never forces an immediate fetch.
  registerClearSettingsCommand(context, () => {
    groups.claude?.usageService.resetKickstartEscalation();
    groups.codex?.usageService.resetKickstartEscalation();
  });
  // Internal click-to-disarm command for the experimental Force Claude
  // Auto-Compact armed status bar item. Not listed in
  // contributes.commands - the only surface is the armed widget click.
  registerCancelExperimentalAutoCompactCommand(
    context,
    () => groups.experimentalAutoCompact?.service ?? null
  );
}

export function deactivate() {
  groups.experimentalAutoCompact = deactivateExperimentalAutoCompact(
    groups.experimentalAutoCompact
  );
  groups.claude = deactivateGroup(groups.claude, "claude", groups);
  groups.codex = deactivateGroup(groups.codex, "codex", groups);
}

function handleConfigChange(e: vscode.ConfigurationChangeEvent): void {
  const config = vscode.workspace.getConfiguration("wat321");

  if (e.affectsConfiguration("wat321.enableClaude")) {
    const enabled = config.get<boolean>("enableClaude", true);
    if (enabled && !groups.claude) {
      groups.claude = activateClaude(groups);
      // The experimental auto-compact service depends on the Claude
      // token service. Bring it up alongside Claude.
      if (!groups.experimentalAutoCompact) {
        groups.experimentalAutoCompact = activateExperimentalAutoCompact(groups);
      }
    } else if (!enabled && groups.claude) {
      // Experimental auto-compact depends on Claude - tear it down first.
      groups.experimentalAutoCompact = deactivateExperimentalAutoCompact(
        groups.experimentalAutoCompact
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

  // Re-render all widgets immediately when display settings change.
  // `displayMode` changes the bar width and the minimal-vs-full
  // layout, and `enableHeatmap` changes the bar coloring and the
  // minimal-view brand text color for both providers. Either needs
  // an immediate refresh so the user sees the change without
  // waiting for the next natural service poll.
  if (
    e.affectsConfiguration("wat321.displayMode") ||
    e.affectsConfiguration("wat321.enableHeatmap")
  ) {
    rebroadcastAll(groups);
  }
}
