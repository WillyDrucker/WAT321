import * as vscode from "vscode";
import type { SessionTarget } from "../../shared/bridge/sessionAliases";

/**
 * Row builders for the OpenCode / Local-LLM "Manage Sessions"
 * submenu. Mirrors the Codex menu's row shape (MODEL, CURRENT, RESET,
 * DELETE, DELETE ALL) so both submenus read the same way. Every row
 * carries `rowKind` because QuickPick reserves `kind` for separators.
 */

export interface PickerRow extends vscode.QuickPickItem {
  rowKind:
    | "back"
    | "model"
    | "current"
    | "reset"
    | "delete"
    | "delete-all"
    | "pause"
    | "resume"
    | "cancel";
  alias?: string;
  instanceId?: string;
}

interface RowBuilderContext {
  target: SessionTarget;
  toolDisplay: "Local" | "OpenCode";
  toolUpper: "LOCAL LLM" | "OPENCODE";
  activeAlias: string | null;
  bucketSize: number;
}

export function buildModelRow(
  ctx: RowBuilderContext,
  modelLabelText: string
): PickerRow {
  // For target=local the row doubles as the entry point into the
  // local-side settings (endpoint URL) - llama.cpp's model is
  // server-controlled, so the row's payload is "settings," not a
  // model picker. For target=opencode the row is a one-click catalog
  // instance switch since OpenCode's model is bound at session create.
  const modelRowLabel =
    ctx.target === "local"
      ? `LOCAL LLM MODEL SETTINGS: ${modelLabelText}`
      : `OPENCODE MODEL: ${modelLabelText}`;
  return {
    rowKind: "model",
    label: modelRowLabel,
    description:
      ctx.target === "local"
        ? "Click to open Local Endpoint settings."
        : "Click to change model.",
    iconPath: new vscode.ThemeIcon(
      ctx.target === "local" ? "settings-gear" : "symbol-method"
    ),
  };
}

export function buildCurrentRow(ctx: RowBuilderContext): PickerRow {
  const currentLabel =
    ctx.activeAlias !== null
      ? `Epic Handshake Claude-to-${ctx.toolDisplay} ${ctx.activeAlias}`
      : `Created on next prompt to ${ctx.toolDisplay}`;
  return {
    rowKind: "current",
    label: `${ctx.toolUpper} SESSION: ${currentLabel}`,
    iconPath: new vscode.ThemeIcon("history"),
  };
}

export function buildResetRow(ctx: RowBuilderContext): PickerRow {
  return {
    rowKind: "reset",
    label: `RESET ${ctx.toolUpper} SESSION`,
    description: "Fresh session on next prompt.",
    detail: `Keeps past ${ctx.toolDisplay} sessions in the alias bucket.`,
    iconPath: new vscode.ThemeIcon("refresh"),
  };
}

/** Always rendered for layout consistency with the Codex menu. When
 * no active alias exists the click handler short-circuits with an
 * info toast rather than hiding the row, so the menu shape stays
 * stable as the user moves between empty and active states. */
export function buildDeleteRow(ctx: RowBuilderContext): PickerRow {
  return {
    rowKind: "delete",
    label:
      ctx.activeAlias !== null
        ? `DELETE ${ctx.toolUpper} SESSION (${ctx.activeAlias})`
        : `DELETE ${ctx.toolUpper} SESSION`,
    description: "Remove the active session.",
    detail:
      ctx.activeAlias !== null
        ? `Deletes the currently active "Epic Handshake" session. Fresh session on next prompt.`
        : undefined,
    iconPath: new vscode.ThemeIcon("trash"),
  };
}

export function buildDeleteAllRow(ctx: RowBuilderContext): PickerRow {
  return {
    rowKind: "delete-all",
    label: `DELETE ALL ${ctx.toolUpper} SESSIONS (${ctx.bucketSize})`,
    description:
      ctx.bucketSize === 0
        ? "Nothing to clear right now."
        : "Removes every bridge session for this workspace.",
    detail:
      ctx.bucketSize === 0
        ? undefined
        : "Fresh session on next prompt.",
    iconPath: new vscode.ThemeIcon("trash"),
  };
}
