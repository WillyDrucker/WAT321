import * as vscode from "vscode";
import { formatRelativeTime } from "../../engine/durationFormat";
import type { OpenCodeRoutesInstance } from "../../shared/bridge/openCodeRoutesConfigSnapshot";
import type { SessionTarget } from "../../shared/bridge/sessionAliases";
import { makeBackItem, makeCancelItem, makePauseResumeItem } from "../../shared/ui/menuRows";
import { EPIC_HANDSHAKE_MENU_TEXT } from "../statusBar/menuActions";
import { formatSessionDisplayName, type OpenCodeSessionMeta } from "./openCodeSessionsSource";
import { isPaused, setPaused } from "../statusBar/statusBarState";

/**
 * Switch-session sub-picker under "Manage Sessions". Lists every
 * alias in the target's bucket with its bound model and age, marks
 * the active one, and hands the choice back to the parent picker,
 * which re-opens itself on `reopen`.
 */

type SwitchOutcome =
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
      const ageLabel =
        typeof meta?.time?.updated === "number"
          ? formatRelativeTime(meta.time.updated)
          : "";
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
  const subPause = makePauseResumeItem(isPaused(), EPIC_HANDSHAKE_MENU_TEXT);
  const switchItems: SwitchRow[] = [
    { ...makeBackItem(), rowType: "back" },
    ...aliasRows,
    {
      ...subPause,
      rowType: subPause.action === "resume" ? "resume" : "pause",
    },
    { ...makeCancelItem(EPIC_HANDSHAKE_MENU_TEXT), rowType: "cancel" },
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
