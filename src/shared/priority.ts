import * as vscode from "vscode";

const DEFAULT_BASE = 1001;

/**
 * Status bar slot offsets. Offset 0 sits leftmost (highest priority);
 * higher offsets shift right. Each widget imports the named constant
 * for its slot rather than passing a magic number, so a future
 * reordering only edits one file.
 */
export const WIDGET_SLOT = {
  claudeUsage5H: 0,
  claudeUsageWeekly: 1,
  codexUsage5H: 2,
  codexUsageWeekly: 3,
  claudeForceAutoCompact: 4,
  claudeSessionTokens: 5,
  codexSessionTokens: 6,
} as const;

export type WidgetSlot = (typeof WIDGET_SLOT)[keyof typeof WIDGET_SLOT];

/** Resolve a slot offset to a concrete VS Code priority value. */
export function getWidgetPriority(offset: WidgetSlot): number {
  const base = vscode.workspace
    .getConfiguration("wat321")
    .get<number>("statusBarPriority", DEFAULT_BASE);
  return base - offset;
}
