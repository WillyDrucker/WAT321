import * as vscode from "vscode";
import { SETTING } from "./settingsKeys";

export type DisplayMode = "full" | "compact" | "minimal";
type RawDisplayMode = DisplayMode | "auto" | "full+compact";

/** Read raw setting value. May return "auto" (display-mode resolution
 * driven by active provider count) or "full+compact" (usage widgets
 * Full while session tokens render Compact). The two split values
 * collapse into one of the three concrete modes via `resolveDisplayMode`
 * for usage widgets, and via `getSessionTokenDisplayMode` for session
 * tokens. */
function getRawDisplayMode(): RawDisplayMode {
  const config = vscode.workspace.getConfiguration("wat321");
  const mode = config.get<string>(SETTING.displayMode, "Auto").toLowerCase();
  if (mode === "auto" || mode === "compact" || mode === "minimal") return mode;
  if (mode === "full") return "full";
  if (mode === "full + compact" || mode === "full+compact") return "full+compact";
  return "auto";
}

/** Resolve "auto" to a concrete mode given an active provider count.
 * Exported so bootstrap's display-mode tracker can call it without
 * needing the full getDisplayMode + registry dependency. */
function resolveDisplayMode(activeProviderCount: number): DisplayMode {
  const raw = getRawDisplayMode();
  // "full+compact" is a split mode: usage widgets stay Full while
  // session-token widgets render Compact. From the usage widget's
  // perspective, that means Full.
  if (raw === "full+compact") return "full";
  if (raw !== "auto") return raw;
  return activeProviderCount >= 2 ? "compact" : "full";
}

/** Per-provider active flags. Updated by the engine via
 * `setProviderActive()` on connectivity transitions and settings-
 * driven deactivation. Read by heatmap.ts for dual-provider
 * brand-color rules and by `getDisplayMode()` to resolve Auto
 * into Compact (2+ active) or Full (0-1 active). */
const providerActiveFlags: Record<string, boolean> = {};
let activeProviderCount = 0;

/** Called by extension.ts after any provider activation change. */
export function setProviderActive(key: string, active: boolean): void {
  providerActiveFlags[key] = active;
  activeProviderCount = Object.values(providerActiveFlags).filter(Boolean).length;
}

/** Is a specific provider currently active? Used by heatmap text
 * color helpers to decide whether a brand marker is needed. */
export function isProviderActive(key: string): boolean {
  return providerActiveFlags[key] ?? false;
}

/** Convenience for widgets - resolves display mode using the
 * current active provider count. */
export function getDisplayMode(): DisplayMode {
  return resolveDisplayMode(activeProviderCount);
}

/** Display mode for session-token widgets specifically. When the
 * display mode is "full+compact", session tokens render Compact even
 * though usage widgets stay Full. Otherwise follows the resolved
 * global mode. Minimal stays minimal everywhere - "minimal" implies
 * the user wants the smallest footprint and the split mode never
 * widens past that. */
export function getSessionTokenDisplayMode(): DisplayMode {
  const raw = getRawDisplayMode();
  if (raw === "full+compact") return "compact";
  return getDisplayMode();
}
