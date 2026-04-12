import * as vscode from "vscode";

export type DisplayMode = "full" | "compact" | "minimal";
export type RawDisplayMode = DisplayMode | "auto";

/**
 * Shared provider activity state. Updated by extension.ts as providers
 * come online or go offline. Read by getDisplayMode() to resolve the
 * "Auto" setting into a concrete display mode.
 *
 * A provider is considered "active" when its CLI is present and it is
 * enabled in settings - including transient states like loading, no-auth,
 * offline, or error. The only state that counts as inactive is
 * "not-connected" (CLI directory missing). This is intentional: Auto mode
 * keys off provider presence, not successful authentication, so the
 * layout does not shift every time a transient error clears.
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
