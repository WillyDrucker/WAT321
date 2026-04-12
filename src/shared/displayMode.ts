import * as vscode from "vscode";

export type DisplayMode = "full" | "compact" | "minimal";
export type RawDisplayMode = DisplayMode | "auto";

/**
 * Shared provider activity state. Updated by extension.ts as providers
 * come online or go offline. Read by getEffectiveDisplayMode() to resolve
 * the "Auto" setting into a concrete display mode.
 */
export const providerState = {
  claudeActive: false,
  codexActive: false,
};

/** Read raw setting value, may return "auto". */
export function getRawDisplayMode(): RawDisplayMode {
  const config = vscode.workspace.getConfiguration("wat321");
  const mode = config.get<string>("displayMode", "Auto").toLowerCase();
  if (mode === "auto" || mode === "compact" || mode === "minimal") return mode;
  if (mode === "full") return "full";
  return "auto";
}

/**
 * Resolved display mode used by widgets.
 * If the setting is "Auto", returns Compact when both providers are active,
 * Full otherwise. Full/Compact/Minimal return themselves.
 */
export function getDisplayMode(): DisplayMode {
  const raw = getRawDisplayMode();
  if (raw === "auto") {
    const activeCount =
      (providerState.claudeActive ? 1 : 0) +
      (providerState.codexActive ? 1 : 0);
    return activeCount >= 2 ? "compact" : "full";
  }
  return raw;
}
