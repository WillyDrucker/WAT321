import * as vscode from "vscode";
import {
  readAliases,
  writeAliases,
  type SessionTarget,
} from "../shared/bridge/sessionAliases";
import {
  makeBackItem,
  makeCancelItem,
  makePauseResumeItem,
  withMenuLifecycle,
} from "./menuCommon";
import {
  ALIAS_PATH,
  buildCurrentRow,
  buildDeleteAllRow,
  buildDeleteRow,
  buildModelRow,
  buildResetRow,
  fetchSessions,
  formatSessionDisplayName,
  pickInstanceForTarget,
  readOpenCodeRoutesConfigSnapshot,
  showSwitchSessionPicker,
  TARGET_CONFIGS,
  type PickerRow,
} from "./openCodeSessionsPickerData";
import { isPaused, setPaused } from "./statusBarState";

/**
 * Manage Sessions submenu (EH widget) for opencode-serve-backed
 * targets: "opencode" (cloud / Big Pickle) and "local" (local LLM).
 *
 * Both targets share opencode serve's session machinery - the only
 * differences are the alias-map namespace and the instance kind
 * filter. A single parameterized picker handles both. Codex's
 * picker stays separate because Codex sessions live in Codex's own
 * rollout files, not in opencode.db.
 *
 * Row set (Codex-style single-active-session model):
 *   - BACK
 *   - <TOOL> MODEL: <name>           (one click switches catalog instance)
 *   - CURRENT <TOOL> SESSION         (click opens switch sub-picker)
 *   - RESET <TOOL> SESSION           (toast confirm - clears active alias)
 *   - DELETE <TOOL> SESSION (S#)     (toast confirm - only when active)
 *   - DELETE ALL <TOOL> SESSIONS (#) (toast confirm)
 *   - PAUSE/RESUME, CANCEL
 *
 * Active-alias state lives in `aliases.activeAliases[target]` in
 * `~/.wat321/bridge/session-aliases.json`. The bridge consumer
 * (bin/opencode.mjs) resolves a missing `session` arg to that
 * active value, so the menu's CURRENT row is the user-facing source
 * of truth and dispatch follows automatically.
 *
 * Row builders + data sources live in `openCodeSessionsPickerData.ts`.
 */

async function showSessionsPicker(
  target: SessionTarget
): Promise<"back" | undefined> {
  const cfg = TARGET_CONFIGS[target];
  const aliases = readAliases(ALIAS_PATH);
  const opencodeCfg = readOpenCodeRoutesConfigSnapshot();
  const serveUrl = opencodeCfg?.openCodeServerUrl ?? null;

  const sessionMetas = serveUrl ? await fetchSessions(serveUrl) : [];
  const metaById = new Map(sessionMetas.map((s) => [s.id, s]));
  const instancesById = new Map(
    (opencodeCfg?.instances ?? []).map((i) => [i.id, i])
  );

  const targetAliases = aliases[target];
  const activeAlias = aliases.activeAliases[target];
  const bucketSize = Object.keys(targetAliases).length;
  const toolDisplay = target === "local" ? "Local" : "OpenCode";
  const toolUpper = target === "local" ? "LOCAL LLM" : "OPENCODE";
  const ctx = { target, toolDisplay, toolUpper, activeAlias, bucketSize } as const;

  // Model label. For opencode the catalog instance alias ("Big
  // Pickle") wins. For local the catalog's `model` field is blank
  // (llama.cpp ignores model id and answers with whatever is loaded)
  // so the truthful name lives on the active session's metadata
  // populated when opencode serve creates a session against the local
  // endpoint. Resolution order: detected local model > catalog alias
  // > first-run hint.
  const activeInstance = pickInstanceForTarget(opencodeCfg, target);
  const activeSessionMeta =
    activeAlias !== null
      ? metaById.get(targetAliases[activeAlias]?.sessionId ?? "")
      : undefined;
  const detectedLocalModel =
    target === "local" ? activeSessionMeta?.model?.id ?? null : null;
  const modelLabelText =
    target === "local"
      ? detectedLocalModel ||
        activeInstance?.alias ||
        "Local LLM (detected on first prompt)"
      : activeInstance?.alias ?? "(none)";

  const paused = isPaused();
  const pauseItem = makePauseResumeItem(paused, false);

  const items: PickerRow[] = [
    { ...makeBackItem(), rowKind: "back" },
    buildModelRow(ctx, modelLabelText),
    buildCurrentRow(ctx),
    buildResetRow(ctx),
    buildDeleteRow(ctx),
    buildDeleteAllRow(ctx),
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
      // Open VS Code's settings UI filtered to local LLM keys so the
      // user can edit `wat321.localEndpoint` without leaving the
      // bridge menu flow.
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
    const outcome = await showSwitchSessionPicker({
      target,
      toolDisplay,
      activeAlias,
      targetAliases,
      metaById,
      instancesById,
    });
    if (outcome.kind === "switched" && outcome.alias !== activeAlias) {
      aliases.activeAliases[target] = outcome.alias;
      writeAliases(ALIAS_PATH, aliases);
      void vscode.window.showInformationMessage(
        `Active ${toolDisplay} session: ${formatSessionDisplayName(target, outcome.alias)}.`
      );
    }
    if (outcome.kind === "close") return;
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

/** Register the cross-tier commands so the OpenCode Routes widget
 * click can route here without violating the tier-import rule
 * (OpenCode Routes cannot import from EH directly - command dispatch
 * is the engine-blessed crossing). */
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
