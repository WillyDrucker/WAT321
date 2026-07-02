import * as vscode from "vscode";
import { SETTING } from "../../engine/settingsKeys";

/**
 * Resolves the `wat321.usageDisplay` setting into a per-provider
 * usage style. "used" counts up - bars fill left to right, 0% to
 * 100%, the percent is consumption. "remaining" counts down - bars
 * drain right to left, 100% to 0%, the percent is what's left.
 *
 * Auto keeps each provider on its native style - the one its own
 * status website shows and the only rendering WAT321 had before
 * this setting existed: Claude used, Codex remaining. Read fresh on
 * every call (same pattern as the heatmap gate). The instant
 * repaint on a settings change comes from `handleConfigChange` in
 * extension.ts rebroadcasting all provider states - without that
 * rebroadcast a flip would sit invisible until the next poll tick.
 */

export type UsageStyle = "used" | "remaining";

const SHOW_USED = "Show Used";
const SHOW_REMAINING = "Show Remaining";

export function resolveUsageStyle(provider: "claude" | "codex"): UsageStyle {
  const raw = vscode.workspace
    .getConfiguration("wat321")
    .get<string>(SETTING.usageDisplay, "Auto");
  if (raw === SHOW_USED) return "used";
  if (raw === SHOW_REMAINING) return "remaining";
  return provider === "claude" ? "used" : "remaining";
}
