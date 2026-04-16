import * as vscode from "vscode";
import { SETTING } from "./settingsKeys";

export type DisplayMode = "full" | "compact" | "minimal";
export type RawDisplayMode = DisplayMode | "auto";

/** Read raw setting value, may return "auto". */
export function getRawDisplayMode(): RawDisplayMode {
  const config = vscode.workspace.getConfiguration("wat321");
  const mode = config.get<string>(SETTING.displayMode, "Auto").toLowerCase();
  if (mode === "auto" || mode === "compact" || mode === "minimal") return mode;
  if (mode === "full") return "full";
  return "auto";
}

/** Resolve "auto" to a concrete mode given an active provider count.
 * Exported so bootstrap's display-mode tracker can call it without
 * needing the full getDisplayMode + registry dependency. */
export function resolveDisplayMode(activeProviderCount: number): DisplayMode {
  const raw = getRawDisplayMode();
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
