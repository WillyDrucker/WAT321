import * as vscode from "vscode";

export type DisplayMode = "full" | "compact" | "minimal";

export function getDisplayMode(): DisplayMode {
  const config = vscode.workspace.getConfiguration("wat321");
  const mode = config.get<string>("displayMode", "Full").toLowerCase();
  if (mode === "compact" || mode === "minimal") return mode;
  return "full";
}
