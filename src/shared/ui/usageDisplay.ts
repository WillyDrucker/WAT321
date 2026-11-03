import * as vscode from "vscode";
import type { ProviderKey } from "../../engine/contracts";
import { SETTING } from "../../engine/settingsKeys";

/**
 * Resolves `wat321.usageDisplay` into a per-provider usage style. "used"
 * fills left to right as consumption grows, "remaining" drains as it
 * shrinks. Auto keeps each provider's native style, the one its own usage
 * page shows: Claude used, Codex remaining. Read fresh on every call, and
 * a flip repaints at once because a settings change rebroadcasts every
 * provider state instead of waiting for the next poll.
 */

export type UsageStyle = "used" | "remaining";

const SHOW_USED = "Show Used";
const SHOW_REMAINING = "Show Remaining";

export function resolveUsageStyle(provider: ProviderKey): UsageStyle {
  const raw = vscode.workspace
    .getConfiguration("wat321")
    .get<string>(SETTING.usageDisplay, "Auto");
  if (raw === SHOW_USED) return "used";
  if (raw === SHOW_REMAINING) return "remaining";
  return provider === "claude" ? "used" : "remaining";
}
