import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { readAliases, writeAliases } from "../shared/bridge/sessionAliases";
import {
  makeBackItem,
  makeCancelItem,
  makePauseResumeItem,
  withMenuLifecycle,
} from "./menuCommon";
import { isPaused, setPaused } from "./statusBarState";

/**
 * Manage Sessions submenu (EH widget) for opencode-serve-backed
 * targets: "opencode" (cloud / Big Pickle) and "local" (local LLM).
 *
 * Both targets share opencode serve's session machinery; the only
 * differences are the alias-map namespace and the instance kind
 * filter. A single parameterized picker handles both, keeping them in
 * lockstep on row order and behavior. Codex's picker stays separate
 * because Codex sessions live in Codex's own rollout files, not in
 * opencode.db.
 *
 * Row set (Codex-style single-active-session model):
 *   - BACK
 *   - <TOOL> MODEL: <name>           (one click switches catalog instance)
 *   - CURRENT <TOOL> SESSION         (click opens switch sub-picker)
 *   - RESET <TOOL> SESSION           (modal confirm; clears active alias)
 *   - DELETE <TOOL> SESSION (S#)     (modal confirm; only when active)
 *   - DELETE ALL <TOOL> SESSIONS (#) (modal confirm)
 *   - PAUSE/RESUME, CANCEL
 *
 * Active-alias state lives in `aliases.activeAliases[target]` in
 * `~/.wat321/bridge/session-aliases.json`. The bridge consumer
 * (bin/opencode.mjs) resolves a missing `session` arg to that active
 * value, so the menu's CURRENT row is the user-facing source of truth
 * and dispatch follows automatically.
 */

export type SessionTarget = "opencode" | "local";

import { bridgeStateDir, modelBridgeStateDir } from "../shared/wat321Paths";

const ALIAS_PATH = join(bridgeStateDir(), "session-aliases.json");
const BRIDGE_CONFIG_PATH = join(bridgeStateDir(), "config.json");
const MB_CONFIG_PATH = join(modelBridgeStateDir(), "config.json");

/** Read the bridge config's projectName for display labels. The
 * bridge tier writes this on activate + workspace-folder change.
 * Fallback "Workspace" matches what the bridge tier uses when no
 * folder is open. */
function readProjectName(): string {
  try {
    if (!existsSync(BRIDGE_CONFIG_PATH)) return "Workspace";
    const raw = readFileSync(BRIDGE_CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw) as { projectName?: unknown };
    if (typeof cfg.projectName === "string" && cfg.projectName.trim().length > 0) {
      return cfg.projectName.trim();
    }
    return "Workspace";
  } catch {
    return "Workspace";
  }
}

/** Standardized session display label. Mirrors the format used in the
 * unified bridge handlers so the picker, the bridge response text,
 * and any future surfaces all read the same way. */
function formatSessionDisplayName(target: SessionTarget, alias: string): string {
  const targetLabel = target === "local" ? "Local" : "OpenCode";
  return `${readProjectName()} Epic Handshake Claude-to-${targetLabel} ${alias}`;
}

interface OpenCodeSessionMeta {
  id: string;
  slug?: string;
  title?: string;
  model?: { id?: string; providerID?: string };
  time?: { created?: number; updated?: number };
}

interface MbInstance {
  id: string;
  alias: string;
  kind: "local" | "remote";
  model: string;
  harnessProviderID: "llama.cpp" | "zen";
}

interface MbConfig {
  openCodeServerUrl?: string;
  activeInstanceId?: string;
  instances?: MbInstance[];
}

function readMbConfig(): MbConfig | null {
  if (!existsSync(MB_CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MB_CONFIG_PATH, "utf8")) as MbConfig;
  } catch {
    return null;
  }
}

async function fetchSessions(serveUrl: string): Promise<OpenCodeSessionMeta[]> {
  try {
    const res = await fetch(`${serveUrl}/session`);
    if (!res.ok) return [];
    const data = (await res.json()) as OpenCodeSessionMeta[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function formatRelative(ms: number | undefined): string {
  if (typeof ms !== "number") return "";
  const ageMs = Date.now() - ms;
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}

interface PickerRow extends vscode.QuickPickItem {
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

const TARGET_CONFIGS: Record<SessionTarget, TargetConfig> = {
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

function pickInstanceForTarget(
  mb: MbConfig | null,
  target: SessionTarget
): MbInstance | null {
  if (!mb) return null;
  const cfg = TARGET_CONFIGS[target];
  const instances = mb.instances ?? [];
  const candidates = instances.filter((i) => i.kind === cfg.instanceKind);
  if (candidates.length === 0) return null;
  const active = candidates.find((i) => i.id === mb.activeInstanceId);
  if (active) return active;
  const fallback = candidates.find((i) => i.id === cfg.fallbackInstanceId);
  if (fallback) return fallback;
  return candidates[0];
}

async function showSessionsPicker(target: SessionTarget): Promise<"back" | undefined> {
  const cfg = TARGET_CONFIGS[target];
  const aliases = readAliases(ALIAS_PATH);
  const mb = readMbConfig();
  const serveUrl = mb?.openCodeServerUrl ?? null;

  const sessionMetas = serveUrl ? await fetchSessions(serveUrl) : [];
  const metaById = new Map(sessionMetas.map((s) => [s.id, s]));
  const instancesById = new Map((mb?.instances ?? []).map((i) => [i.id, i]));

  const targetAliases = aliases[target];
  const activeAlias = aliases.activeAliases[target];
  const bucketSize = Object.keys(targetAliases).length;

  // Model label shown on the MODEL row. For opencode we render the
  // catalog instance alias ("Big Pickle"). For local the catalog's
  // `model` field is intentionally blank (llama.cpp ignores model id
  // and answers with whatever is loaded), so the truthful name lives
  // on the active session's metadata, populated when opencode serve
  // creates a session against the local endpoint. Resolution order:
  //   1. active session's `model.id` from /session metadata
  //   2. catalog instance alias ("Local LLM" by default)
  //   3. "Local LLM (detected on first prompt)" first-run hint
  const activeInstance = pickInstanceForTarget(mb, target);
  const activeAliasForLabel = aliases.activeAliases[target];
  const activeSessionMeta =
    activeAliasForLabel !== null
      ? metaById.get(targetAliases[activeAliasForLabel]?.sessionId ?? "")
      : undefined;
  const detectedLocalModel =
    target === "local" ? activeSessionMeta?.model?.id ?? null : null;
  const modelLabelText =
    target === "local"
      ? detectedLocalModel ||
        activeInstance?.alias ||
        "Local LLM (detected on first prompt)"
      : activeInstance?.alias ?? "(none)";
  // For target=local the row doubles as the entry point into the
  // local-side settings (endpoint URL, related knobs) - llama.cpp's
  // model is server-controlled, so the row's payload is "settings,"
  // not a model picker. For target=opencode the row stays a one-click
  // catalog instance switch since OpenCode's model is bound at session
  // create.
  const modelRowLabel =
    target === "local"
      ? `LOCAL LLM MODEL SETTINGS: ${modelLabelText}`
      : `OPENCODE MODEL: ${modelLabelText}`;
  const modelRow: PickerRow = {
    rowKind: "model",
    label: modelRowLabel,
    description:
      target === "local"
        ? "Click to open Local Endpoint settings."
        : "Click to change model.",
    iconPath: new vscode.ThemeIcon(
      target === "local" ? "settings-gear" : "symbol-method"
    ),
  };

  // SESSION row. Mirrors Codex's row exactly: shows the active alias'
  // display name, or the "Created on next prompt to ..." hint when
  // nothing is active. Click opens the switch sub-picker (when multiple
  // aliases exist) or shows a hint toast when only the active one
  // exists. Active row in the sub-picker carries a green check.
  const toolDisplay = target === "local" ? "Local" : "OpenCode";
  const toolUpper = target === "local" ? "LOCAL LLM" : "OPENCODE";
  const currentLabel =
    activeAlias !== null
      ? `Epic Handshake Claude-to-${toolDisplay} ${activeAlias}`
      : `Created on next prompt to ${toolDisplay}`;
  const currentRow: PickerRow = {
    rowKind: "current",
    label: `${toolUpper} SESSION: ${currentLabel}`,
    iconPath: new vscode.ThemeIcon("history"),
  };

  const resetRow: PickerRow = {
    rowKind: "reset",
    label: `RESET ${toolUpper} SESSION`,
    description: "Fresh session on next prompt.",
    detail: `Keeps past ${toolDisplay} sessions in the alias bucket.`,
    iconPath: new vscode.ThemeIcon("refresh"),
  };

  // Always rendered for layout consistency with the Codex menu. When
  // no active alias exists the click handler short-circuits with an
  // info toast rather than hiding the row, so the menu shape stays
  // stable as the user moves between empty and active states.
  const deleteRow: PickerRow = {
    rowKind: "delete",
    label:
      activeAlias !== null
        ? `DELETE ${toolUpper} SESSION (${activeAlias})`
        : `DELETE ${toolUpper} SESSION`,
    description: "Remove the active session.",
    detail:
      activeAlias !== null
        ? `Deletes the currently active "Epic Handshake" session. Fresh session on next prompt.`
        : undefined,
    iconPath: new vscode.ThemeIcon("trash"),
  };

  const deleteAllRow: PickerRow = {
    rowKind: "delete-all",
    label: `DELETE ALL ${toolUpper} SESSIONS (${bucketSize})`,
    description:
      bucketSize === 0
        ? "Nothing to clear right now."
        : "Removes every bridge session for this workspace.",
    detail: bucketSize === 0 ? undefined : "Fresh session on next prompt.",
    iconPath: new vscode.ThemeIcon("trash"),
  };

  const paused = isPaused();
  const pauseItem = makePauseResumeItem(paused, false);

  const items: PickerRow[] = [
    { ...makeBackItem(), rowKind: "back" },
    modelRow,
    currentRow,
    resetRow,
    deleteRow,
    deleteAllRow,
    {
      ...pauseItem,
      rowKind: pauseItem.action === "resume" ? "resume" : "pause",
    },
    { ...makeCancelItem(false), rowKind: "cancel" },
  ];

  const pick = await withMenuLifecycle(() =>
    vscode.window.showQuickPick<PickerRow>(items, {
      title: cfg.title,
      placeHolder: bucketSize === 0 ? cfg.emptyHint : "Choose an action",
    })
  );
  if (!pick || pick.rowKind === "cancel") return;
  if (pick.rowKind === "back") return "back";

  if (pick.rowKind === "pause") {
    setPaused(true);
    return;
  }
  if (pick.rowKind === "resume") {
    setPaused(false);
    return showSessionsPicker(target);
  }

  if (pick.rowKind === "model") {
    if (target === "local") {
      // Open VS Code's settings UI filtered to the local LLM keys so
      // the user can edit `wat321.localEndpoint` (and any future
      // local-side knobs) without leaving the bridge menu flow.
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@id:wat321.localEndpoint"
      );
      return;
    }
    await vscode.commands.executeCommand(
      "wat321.modelBridge.pickActiveInstance",
      "remote"
    );
    return showSessionsPicker(target);
  }

  if (pick.rowKind === "current") {
    if (bucketSize === 0) {
      void vscode.window.showInformationMessage(
        `No ${toolDisplay} sessions yet. The next prompt to ${toolDisplay} creates one automatically.`
      );
      return showSessionsPicker(target);
    }
    interface SwitchRow extends vscode.QuickPickItem {
      rowType: "session" | "back" | "pause" | "resume" | "cancel";
      alias?: string;
    }
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
    const subPause = makePauseResumeItem(paused, false);
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
    if (!switchPick || switchPick.rowType === "cancel") return;
    if (switchPick.rowType === "back") return showSessionsPicker(target);
    if (switchPick.rowType === "pause") {
      setPaused(true);
      return;
    }
    if (switchPick.rowType === "resume") {
      setPaused(false);
      return showSessionsPicker(target);
    }
    if (switchPick.rowType === "session" && switchPick.alias !== undefined) {
      if (switchPick.alias !== activeAlias) {
        aliases.activeAliases[target] = switchPick.alias;
        writeAliases(ALIAS_PATH, aliases);
        void vscode.window.showInformationMessage(
          `Active ${toolDisplay} session: ${formatSessionDisplayName(target, switchPick.alias)}.`
        );
      }
    }
    return showSessionsPicker(target);
  }

  if (pick.rowKind === "reset") {
    if (activeAlias === null) {
      void vscode.window.showInformationMessage(
        `No active ${toolDisplay} session. The next prompt creates a fresh one.`
      );
      return showSessionsPicker(target);
    }
    const confirm = await vscode.window.showWarningMessage(
      `Reset ${toolDisplay} session? Next prompt starts fresh. The current alias (${activeAlias}) stays in the bucket and can be re-selected from CURRENT.`,
      "Reset",
      "Cancel"
    );
    if (confirm !== "Reset") return showSessionsPicker(target);
    aliases.activeAliases[target] = null;
    writeAliases(ALIAS_PATH, aliases);
    void vscode.window.showInformationMessage(
      `${toolDisplay}: active session cleared. Next prompt creates a fresh session.`
    );
    return showSessionsPicker(target);
  }

  if (pick.rowKind === "delete") {
    if (activeAlias === null) {
      void vscode.window.showInformationMessage(
        `No active ${toolDisplay} session to delete. Use DELETE ALL to clear past sessions.`
      );
      return showSessionsPicker(target);
    }
    const display = formatSessionDisplayName(target, activeAlias);
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${toolDisplay} session "${display}"? Removes the alias entry for ${activeAlias}. The underlying opencode session is retained in opencode.db for recovery.`,
      "Delete",
      "Cancel"
    );
    if (confirm !== "Delete") return showSessionsPicker(target);
    delete targetAliases[activeAlias];
    aliases.activeAliases[target] = null;
    writeAliases(ALIAS_PATH, aliases);
    void vscode.window.showInformationMessage(
      `Deleted ${toolDisplay} session ${activeAlias}.`
    );
    return showSessionsPicker(target);
  }

  if (pick.rowKind === "delete-all") {
    if (bucketSize === 0) {
      void vscode.window.showInformationMessage(
        `No ${toolDisplay} sessions to delete.`
      );
      return showSessionsPicker(target);
    }
    const confirm = await vscode.window.showWarningMessage(
      `Delete ALL ${bucketSize} ${toolDisplay} session${bucketSize === 1 ? "" : "s"}? Clears every alias. Underlying opencode sessions are retained in opencode.db for recovery.`,
      "Delete All",
      "Cancel"
    );
    if (confirm !== "Delete All") return showSessionsPicker(target);
    aliases[target] = {};
    aliases.activeAliases[target] = null;
    writeAliases(ALIAS_PATH, aliases);
    void vscode.window.showInformationMessage(
      `${toolDisplay}: cleared ${bucketSize} session${bucketSize === 1 ? "" : "s"}.`
    );
    return showSessionsPicker(target);
  }
}

export async function showOpenCodeSessionsPicker(): Promise<"back" | undefined> {
  return showSessionsPicker("opencode");
}

export async function showLocalLLMSessionsPicker(): Promise<"back" | undefined> {
  return showSessionsPicker("local");
}

/** Register the cross-tier commands so the OpenCode Routes widget click can route
 * here without violating the tier-import rule (MB cannot import from
 * EH directly; command dispatch is the engine-blessed crossing). */
export function registerSessionPickerCommands(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "wat321.bridge.manageOpenCodeSessions",
      async () => showOpenCodeSessionsPicker()
    ),
    vscode.commands.registerCommand(
      "wat321.bridge.manageLocalLlmSessions",
      async () => showLocalLLMSessionsPicker()
    )
  );
}
