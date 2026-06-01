import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { SessionTarget } from "../shared/bridge/sessionAliases";
import { bridgeStateDir, openCodeRoutesStateDir } from "../shared/wat321Paths";
import {
  makeBackItem,
  makeCancelItem,
  makePauseResumeItem,
} from "./menuCommon";
import { isPaused, setPaused } from "./statusBarState";

/**
 * Data sources, row builders, and the switch sub-picker for the
 * OpenCode / Local-LLM "Manage Sessions" submenu. The main picker
 * shell lives in `openCodeSessionsPicker.ts`; this file owns
 * everything that does NOT directly drive the parent QuickPick
 * lifecycle.
 */

export const ALIAS_PATH = join(bridgeStateDir(), "session-aliases.json");
const BRIDGE_CONFIG_PATH = join(bridgeStateDir(), "config.json");
const OPENCODE_ROUTES_CONFIG_PATH = join(
  openCodeRoutesStateDir(),
  "config.json"
);

/** Bridge config's projectName for display labels. The bridge tier
 * writes this on activate + workspace-folder change. Fallback
 * "Workspace" matches the bridge tier's own fallback. */
export function readProjectName(): string {
  try {
    if (!existsSync(BRIDGE_CONFIG_PATH)) return "Workspace";
    const raw = readFileSync(BRIDGE_CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw) as { projectName?: unknown };
    if (
      typeof cfg.projectName === "string" &&
      cfg.projectName.trim().length > 0
    ) {
      return cfg.projectName.trim();
    }
    return "Workspace";
  } catch {
    return "Workspace";
  }
}

/** Standardized session display label. Mirrors the unified bridge
 * handlers so the picker, bridge response text, and any future
 * surfaces all read the same way. */
export function formatSessionDisplayName(
  target: SessionTarget,
  alias: string
): string {
  const targetLabel = target === "local" ? "Local" : "OpenCode";
  return `${readProjectName()} Epic Handshake Claude-to-${targetLabel} ${alias}`;
}

export function formatRelative(ms: number | undefined): string {
  if (typeof ms !== "number") return "";
  const ageMs = Date.now() - ms;
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}

export interface OpenCodeSessionMeta {
  id: string;
  slug?: string;
  title?: string;
  model?: { id?: string; providerID?: string };
  time?: { created?: number; updated?: number };
}

export interface OpenCodeRoutesInstance {
  id: string;
  alias: string;
  kind: "local" | "remote";
  model: string;
  harnessProviderID: "llama.cpp" | "zen";
}

export interface OpenCodeRoutesConfigSnapshot {
  openCodeServerUrl?: string;
  activeInstanceId?: string;
  instances?: OpenCodeRoutesInstance[];
}

export function readOpenCodeRoutesConfigSnapshot(): OpenCodeRoutesConfigSnapshot | null {
  if (!existsSync(OPENCODE_ROUTES_CONFIG_PATH)) return null;
  try {
    return JSON.parse(
      readFileSync(OPENCODE_ROUTES_CONFIG_PATH, "utf8")
    ) as OpenCodeRoutesConfigSnapshot;
  } catch {
    return null;
  }
}

export async function fetchSessions(
  serveUrl: string
): Promise<OpenCodeSessionMeta[]> {
  try {
    const res = await fetch(`${serveUrl}/session`);
    if (!res.ok) return [];
    const data = (await res.json()) as OpenCodeSessionMeta[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

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

interface TargetConfig {
  title: string;
  instanceKind: "local" | "remote";
  fallbackInstanceId: string;
  emptyHint: string;
}

export const TARGET_CONFIGS: Record<SessionTarget, TargetConfig> = {
  opencode: {
    title: "Manage OpenCode",
    instanceKind: "remote",
    fallbackInstanceId: "big-pickle",
    emptyHint: "No OpenCode sessions yet. The next prompt creates one.",
  },
  local: {
    title: "Manage Local LLM",
    instanceKind: "local",
    fallbackInstanceId: "local-llm",
    emptyHint:
      "No Local LLM sessions yet. The next prompt creates one (requires Local Endpoint set in WAT321 settings).",
  },
};

export function pickInstanceForTarget(
  opencodeCfg: OpenCodeRoutesConfigSnapshot | null,
  target: SessionTarget
): OpenCodeRoutesInstance | null {
  if (!opencodeCfg) return null;
  const cfg = TARGET_CONFIGS[target];
  const instances = opencodeCfg.instances ?? [];
  const candidates = instances.filter((i) => i.kind === cfg.instanceKind);
  if (candidates.length === 0) return null;
  const active = candidates.find((i) => i.id === opencodeCfg.activeInstanceId);
  if (active) return active;
  const fallback = candidates.find(
    (i) => i.id === cfg.fallbackInstanceId
  );
  if (fallback) return fallback;
  return candidates[0];
}

export interface RowBuilderContext {
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

/** Switch-session sub-picker. Returns the alias the user picked (or
 * null to indicate no change). `back` returns to the parent picker;
 * pause/resume/cancel signaled via the void return. The caller re-
 * opens the parent picker on its own. */
export type SwitchOutcome =
  | { kind: "switched"; alias: string }
  | { kind: "reopen" }
  | { kind: "close" };

interface SwitchRow extends vscode.QuickPickItem {
  rowType: "session" | "back" | "pause" | "resume" | "cancel";
  alias?: string;
}

export async function showSwitchSessionPicker(args: {
  target: SessionTarget;
  toolDisplay: "Local" | "OpenCode";
  activeAlias: string | null;
  targetAliases: Record<
    string,
    { sessionId: string; instanceId?: string | null }
  >;
  metaById: Map<string, OpenCodeSessionMeta>;
  instancesById: Map<string, OpenCodeRoutesInstance>;
}): Promise<SwitchOutcome> {
  const {
    target,
    toolDisplay,
    activeAlias,
    targetAliases,
    metaById,
    instancesById,
  } = args;
  const aliasRows: SwitchRow[] = Object.entries(targetAliases).map(
    ([alias, entry]) => {
      const meta = metaById.get(entry.sessionId);
      const boundInstance = entry.instanceId
        ? instancesById.get(entry.instanceId)
        : null;
      const modelHint =
        boundInstance?.alias ?? meta?.model?.id ?? "(no model)";
      const ageLabel = formatRelative(meta?.time?.updated);
      const display = formatSessionDisplayName(target, alias);
      const isActive = alias === activeAlias;
      return {
        rowType: "session",
        label: `${isActive ? "✔️ " : ""}${display}`,
        description: `${modelHint}${ageLabel ? `  -  ${ageLabel}` : ""}`,
        alias,
      };
    }
  );
  const subPause = makePauseResumeItem(isPaused(), false);
  const switchItems: SwitchRow[] = [
    { ...makeBackItem(), rowType: "back" },
    ...aliasRows,
    {
      ...subPause,
      rowType: subPause.action === "resume" ? "resume" : "pause",
    },
    { ...makeCancelItem(false), rowType: "cancel" },
  ];
  const switchPick = await vscode.window.showQuickPick<SwitchRow>(
    switchItems,
    {
      title: `Switch ${toolDisplay} session`,
      placeHolder: "Pick a session to mark active",
    }
  );
  if (!switchPick || switchPick.rowType === "cancel") return { kind: "close" };
  if (switchPick.rowType === "back") return { kind: "reopen" };
  if (switchPick.rowType === "pause") {
    setPaused(true);
    return { kind: "close" };
  }
  if (switchPick.rowType === "resume") {
    setPaused(false);
    return { kind: "reopen" };
  }
  if (switchPick.rowType === "session" && switchPick.alias !== undefined) {
    return { kind: "switched", alias: switchPick.alias };
  }
  return { kind: "close" };
}
