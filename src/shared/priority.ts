import * as vscode from "vscode";

const DEFAULT_BASE = 1001;

/**
 * Get widget priority based on the configured base.
 * Offset 0 = highest (leftmost), higher offsets shift right.
 *
 * Current offsets:
 *   0 = Claude Usage 5hr
 *   1 = Claude Usage Weekly
 *   2 = Codex Usage 5 hour
 *   3 = Codex Usage Weekly
 *   4 = Claude Force Auto-Compact (interactive)
 *   5 = Claude Session Tokens
 *   6 = Codex Session Tokens
 */
export function getWidgetPriority(offset: number): number {
  const base = vscode.workspace
    .getConfiguration("wat321")
    .get<number>("statusBarPriority", DEFAULT_BASE);
  return base - offset;
}
