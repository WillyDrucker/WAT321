import * as vscode from "vscode";
import { formatDuration } from "../../engine/durationFormat";
import { SETTING } from "../../engine/settingsKeys";
import { workspaceHash } from "../../engine/workspaceHash";
import { listLateReplies } from "../../engine/inbox/inboxReader";
import { latestAlias, readAliases, SESSION_ALIASES_PATH } from "../../shared/bridge/sessionAliases";
import { EPIC_HANDSHAKE_MENU_TEXT, makeInFlightLockedItem, type Item } from "./menuActions";
import { makeCancelItem, makePauseResumeItem } from "../../shared/ui/menuRows";
import { createMenuDispatch } from "./statusBarMenuActions";
import { currentWorkspacePath, isPaused } from "./statusBarState";
import { listRecoverableSessions } from "../codexTurn/sessionRecovery";
import { loadBridgeThreadRecord } from "../codexTurn/threadRecord";
import { readNewestHeartbeat } from "../bridgeStage/turnHeartbeat";
import {
  currentWaitMode,
  nextWaitMode,
  waitModeLabel,
} from "../codexTurn/waitMode";
import type { BridgeStage } from "../../engine/bridgeTypes";

/**
 * Main QuickPick entry point for the Epic Handshake widget. The
 * status bar item registers a command that calls `showMainMenu` -
 * action handling lives in `statusBarMenuActions.ts` and is wired
 * here via `createMenuDispatch`. Sub-pickers (menuPickers.ts,
 * lateReplyPickers.ts, codexDefaultsPicker.ts) receive the same
 * dispatch closure so every action has exactly one switch.
 *
 * Action types and the in-flight lock live in `menuActions.ts`, the shared rows in `shared/ui/menuRows.ts`.
 */

const STAGE_LABELS: Record<BridgeStage, string> = {
  dispatched: "1/5 dispatched",
  received: "2/5 received",
  working: "3/5 working",
  writing: "4/5 writing",
  complete: "5/5 complete",
};

/** Stuck-on-flush thresholds for the writing-stage warning copy. The
 * bridge auto-abort fires at 10 minutes of no heartbeat updates
 * (issue #61) - the lower bars below surface a hint in the menu well
 * before that so the operator can cancel + retry instead of waiting
 * out the full window. Read-only - only changes what string the
 * cancel-adjacent status row shows. */
const STAGE_AGE_WARN_MS = 3 * 60_000;
const ACTIVITY_GAP_WARN_MS = 60_000;

/** Build the BRIDGE STATUS row. Null when no fresh heartbeat exists
 * for this workspace (no live turn). Surfacing stage + time-in-stage
 * + time-since-last-activity addresses issue #67: distinguishes
 * "still doing tool work" from "finished work, stuck on flush" so
 * the operator can cancel earlier than the 10-minute auto-abort. */
function makeInFlightStatusItem(ws: string | null): Item | null {
  if (!ws) return null;
  const wsHash = workspaceHash(ws);
  const hb = readNewestHeartbeat(wsHash);
  if (!hb) return null;

  const now = Date.now();
  const stageEnteredAt = hb.stageEnteredAt?.[hb.stage] ?? hb.lastProgressAt;
  const stageAgeMs = now - stageEnteredAt;
  const sinceActivityMs = now - hb.lastProgressAt;

  const stuckInWriting =
    hb.stage === "writing" &&
    stageAgeMs > STAGE_AGE_WARN_MS &&
    sinceActivityMs > ACTIVITY_GAP_WARN_MS;
  const generallyStalled =
    !stuckInWriting && sinceActivityMs > ACTIVITY_GAP_WARN_MS;

  const lines: string[] = [
    `${STAGE_LABELS[hb.stage]} for ${formatDuration(stageAgeMs)}`,
    `last update ${formatDuration(sinceActivityMs)} ago`,
  ];
  if (hb.activeTool) lines.push(`tool: ${hb.activeTool}`);
  if (stuckInWriting) lines.push("looks stuck on flush - consider CANCEL");
  else if (generallyStalled) lines.push("no recent activity - watching");

  return {
    label: "BRIDGE STATUS",
    description: stuckInWriting
      ? "Stage 4/5 has not advanced - reply may be stuck on flush"
      : "Live snapshot of the in-flight Codex turn",
    detail: lines.join(" | "),
    iconPath: new vscode.ThemeIcon("wat321-square-info"),
    action: "in-flight-info",
  };
}

export async function showMainMenu(opts: { inFlight: boolean }): Promise<void> {
  const paused = isPaused();
  const ws = currentWorkspacePath();
  const lateReplies = ws ? listLateReplies(ws) : [];
  const lateCount = lateReplies.length;
  const currentRecord = ws ? loadBridgeThreadRecord(ws) : null;
  const hasError = (currentRecord?.consecutiveFailures ?? 0) > 0;
  const sessionCounter = currentRecord?.sessionCounter ?? 1;
  // Only show MANAGE CODEX (S<n>) when an active session exists.
  // After delete-all / reset the stored counter holds the projected-
  // next for the upcoming spawn, but showing it as live confuses users
  // who just cleared their sessions. Matches the submenu's "Created
  // on next prompt to Codex" pattern and mirrors how MANAGE OPENCODE
  // / MANAGE LOCAL LLM omit an alias when no session is bound.
  const hasActiveCodexSession =
    currentRecord?.threadId !== null && currentRecord?.threadId !== undefined;

  const pauseItem = makePauseResumeItem(paused, EPIC_HANDSHAKE_MENU_TEXT);
  const cancelItem = makeCancelItem(EPIC_HANDSHAKE_MENU_TEXT);

  const retrieveItem: Item = {
    label: `RETRIEVE LATE REPLIES (${lateCount})`,
    description:
      lateCount === 0
        ? "No pending replies right now."
        : "Copies to clipboard and clears the inbox.",
    iconPath: new vscode.ThemeIcon("mail"),
    action: "retrieve",
  };

  // Display STANDARD as ADAPTIVE (the implicit default) so the user
  // never sees an unselectable label, and the toggle on click
  // resolves to FIRE & FORGET as expected.
  const rawCurrent = ws ? currentWaitMode(ws) : "standard";
  const current = rawCurrent === "standard" ? "adaptive" : rawCurrent;
  const next = nextWaitMode(current);
  // Wait mode locks while a turn is in flight. Switching mid-turn
  // would let the in-flight envelope's dispatcher flags go out of
  // sync with the newly-selected mode. The row stays visible showing
  // the current mode but cannot flip - the action-handler guard
  // enforces the lock even if the click lands between build and
  // handle.
  const waitModeItem: Item | null = paused
    ? null
    : opts.inFlight
      ? makeInFlightLockedItem(`WAIT MODE: ${waitModeLabel(current)}`)
      : {
          label: `WAIT MODE: ${waitModeLabel(current)}`,
          description: `Click to switch to ${waitModeLabel(next)}.`,
          iconPath: new vscode.ThemeIcon("wat321-square-bolt"),
          action: "wait-mode-toggle",
        };

  const sessionsItem: Item = {
    label: hasActiveCodexSession
      ? `MANAGE CODEX (S${sessionCounter})`
      : "MANAGE CODEX",
    description: "Switch, reset, delete, or change model settings.",
    iconPath: new vscode.ThemeIcon("wat321-square-info"),
    action: "manage-sessions",
  };

  // Cross-tier entry into OpenCode + Local LLM session management.
  // Hidden when both backends are off so the menu stays lean for
  // EH/Codex-only users. Both sub-pickers live in
  // openCodeSessionsPicker.ts and mirror the Codex menu's row shape
  // (CURRENT/RESET/DELETE/DELETE ALL) on top of the unified bridge's
  // active-alias state.
  const openCodeEnabled = vscode.workspace
    .getConfiguration("wat321")
    .get<boolean>(SETTING.enableOpenCode, false);
  const localEndpoint = vscode.workspace
    .getConfiguration("wat321")
    .get<string>(SETTING.localEndpoint, "")
    .trim();
  // S# suffix on the parent label mirrors Codex's `MANAGE CODEX
  // (S<n>)` pattern. Show the highest S# present (the working
  // session), not a count.
  const bridgeAliases = readAliases(SESSION_ALIASES_PATH);
  const opencodeLatest = latestAlias(bridgeAliases.opencode);
  const localLatest = latestAlias(bridgeAliases.local);
  const opencodeSessionsItem: Item | null = openCodeEnabled
    ? {
        label: opencodeLatest
          ? `MANAGE OPENCODE (${opencodeLatest})`
          : "MANAGE OPENCODE",
        description: "List, resume, or manage OpenCode sessions.",
        iconPath: new vscode.ThemeIcon("wat321-square-info"),
        action: "manage-opencode-sessions",
      }
    : null;
  // Local LLM submenu only shows when OpenCode Routes is enabled AND
  // a local endpoint is configured. Without an endpoint, the local
  // target has nothing to dispatch to and the submenu would be dead.
  const localLlmSessionsItem: Item | null =
    openCodeEnabled && localEndpoint.length > 0
      ? {
          label: localLatest
            ? `MANAGE LOCAL LLM (${localLatest})`
            : "MANAGE LOCAL LLM",
          description: "List, resume, or manage local LLM sessions.",
          iconPath: new vscode.ThemeIcon("wat321-square-info"),
          action: "manage-local-llm-sessions",
        }
      : null;

  const clearErrorItem: Item | null =
    hasError && !paused
      ? {
          label: "CLEAR",
          description:
            "Clears bridge errors, only if there's something to clear.",
          detail: currentRecord?.lastError
            ? `Last error: ${currentRecord.lastError.slice(0, 120)}`
            : undefined,
          iconPath: new vscode.ThemeIcon("wat321-square-check"),
          action: "clear-error",
        }
      : null;

  // Backup safety net for the rare case where Codex's app-server has
  // cached stale config or otherwise needs a hard reset. Bundles
  // cancel + clear + force-kill so the user has one click instead of
  // three. Resumes the active S<n> bridge thread on the next prompt -
  // does NOT touch the Codex VS Code extension itself (that would
  // require a full window reload). Always visible because the value
  // is exactly that it works when nothing else does.
  const restartBridgeItem: Item = {
    label: "RESTART EPIC HANDSHAKE BRIDGE",
    description: `Cancel, clear and restart bridge. Resumes (S${sessionCounter}) on next prompt.`,
    iconPath: new vscode.ThemeIcon("sync"),
    action: "restart-bridge",
  };

  // In-flight status appears at the top when a turn is active so the
  // operator sees stage + age + activity gap before scanning down to
  // the actions. Issue #67: distinguishes "still working" from "stuck
  // on flush" without waiting for the 10-minute auto-abort.
  const inFlightStatusItem = opts.inFlight ? makeInFlightStatusItem(ws) : null;

  // Menu ordering: in-flight status (when active), retrieve up top,
  // sessions immediately below, wait-mode toggle, conditional clear,
  // restart-bridge above pause, then pause + cancel always at the
  // bottom. Pause and cancel appear in every menu (including
  // submenus) for consistent escape paths.
  const items: Item[] = [
    ...(inFlightStatusItem ? [inFlightStatusItem] : []),
    retrieveItem,
    sessionsItem,
    ...(opencodeSessionsItem ? [opencodeSessionsItem] : []),
    ...(localLlmSessionsItem ? [localLlmSessionsItem] : []),
    ...(waitModeItem ? [waitModeItem] : []),
    ...(clearErrorItem ? [clearErrorItem] : []),
    restartBridgeItem,
    pauseItem,
    cancelItem,
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: `WAT321 Epic Handshake${paused ? " (paused)" : ""}`,
    placeHolder: "Choose an action",
  });
  if (!pick) return;

  const dispatch = createMenuDispatch({ reopenMainMenu: showMainMenu });
  await dispatch(pick.action, {
    ws,
    lateReplies,
    recoverable: ws ? listRecoverableSessions(ws) : [],
    inFlight: opts.inFlight,
  });
}
