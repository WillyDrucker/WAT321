import { writeFileAtomic } from "../shared/fs/atomicWrite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeStateDir } from "../shared/wat321Paths";
import * as vscode from "vscode";
import { SETTING } from "../engine/settingsKeys";
import { waitModeFlashFlagPath } from "./constants";
import { listLateReplies } from "./lateReplyInbox";
import {
  makeCancelItem,
  makePauseResumeItem,
  withMenuLifecycle,
  type Action,
  type ActionContext,
  type Item,
} from "./menuCommon";
import { showCodexDefaultsPicker } from "./codexDefaultsPicker";
import {
  showLocalLLMSessionsPicker,
  showOpenCodeSessionsPicker,
} from "./openCodeSessionsPicker";
import {
  discardAllLateReplies,
  showLateRepliesPicker,
} from "./lateReplyPickers";
import {
  showRecoverSessionPicker,
  showRepairSessionsPicker,
  showSessionsSubmenu,
} from "./menuPickers";
import {
  currentWorkspacePath,
  isBridgeBusy,
  isPaused,
  setPaused,
} from "./statusBarState";
import {
  clearBridgeErrorState,
  listRecoverableSessions,
  loadBridgeThreadRecord,
} from "./threadPersistence";
import { readNewestHeartbeat, type Stage } from "./turnHeartbeat";
import { writeCancelFlag } from "./turnFlags";
import {
  applyWaitMode,
  currentWaitMode,
  nextWaitMode,
  waitModeLabel,
} from "./waitMode";
import { workspaceHash } from "../shared/workspaceHash";

/** Read the unified bridge's alias map for the current S# suffix on
 * the parent menu's MANAGE OPENCODE/LOCAL rows. Only the alias keys
 * are consumed here, so the value shape is left as `unknown` -
 * tolerates both legacy string entries and the new `{sessionId,
 * instanceId}` form without coupling this menu to either schema. */
const BRIDGE_ALIASES_PATH = join(bridgeStateDir(), "session-aliases.json");
function readBridgeAliases(): {
  opencode: Record<string, unknown>;
  local: Record<string, unknown>;
} {
  try {
    if (!existsSync(BRIDGE_ALIASES_PATH)) return { opencode: {}, local: {} };
    const parsed = JSON.parse(readFileSync(BRIDGE_ALIASES_PATH, "utf8")) as {
      opencode?: Record<string, unknown>;
      local?: Record<string, unknown>;
    };
    return {
      opencode:
        parsed.opencode && typeof parsed.opencode === "object" ? parsed.opencode : {},
      local: parsed.local && typeof parsed.local === "object" ? parsed.local : {},
    };
  } catch {
    return { opencode: {}, local: {} };
  }
}

/** Highest S<n> alias by numeric suffix. Returns `null` when no
 * sessions exist for the target. Mirrors how the Codex menu shows
 * the active sessionCounter rather than a count - the user reads
 * "S<n>" as the working session, not "<n> sessions exist". */
function latestAlias(map: Record<string, unknown>): string | null {
  const aliases = Object.keys(map);
  if (aliases.length === 0) return null;
  let bestNum = -1;
  let bestAlias: string | null = null;
  for (const alias of aliases) {
    const m = /^S(\d+)$/.exec(alias);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n > bestNum) {
      bestNum = n;
      bestAlias = alias;
    }
  }
  return bestAlias;
}

/** Format a millisecond duration as `HhMmSs` / `MmSs` / `Ss` for menu
 * detail rendering. Stays compact - QuickPick's `detail` line truncates
 * around 60 chars on most themes. */
function formatStageDuration(ms: number): string {
  if (ms < 1000) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

const STAGE_LABELS: Record<Stage, string> = {
  dispatched: "1/5 dispatched",
  received: "2/5 received",
  working: "3/5 working",
  writing: "4/5 writing",
  complete: "5/5 complete",
};

/** Stuck-on-flush threshold for the writing stage. The bridge auto-
 * abort fires at 10 minutes of no heartbeat updates (issue #61); this
 * lower bar surfaces a warning hint in the menu well before that so
 * the operator can cancel + retry instead of waiting out the full
 * 10-minute window. Any-stage activity gap > 60s triggers; writing-
 * stage age > 3 minutes piles on the "likely stuck" copy.
 *
 * Read-only: this only changes what string the cancel item shows. The
 * actual cancel + auto-abort timing is unchanged. */
const STAGE_AGE_WARN_MS = 3 * 60_000;
const ACTIVITY_GAP_WARN_MS = 60_000;

/** Build the in-flight status item. Returns null when no fresh
 * heartbeat exists for this workspace (no live turn to describe).
 * Surfacing stage + time-in-stage + time-since-last-activity addresses
 * issue #67: the operator can distinguish "still doing tool work"
 * from "finished work, stuck on flush" and decide to cancel earlier
 * rather than waiting for the 10-minute auto-abort. */
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
    `${STAGE_LABELS[hb.stage]} for ${formatStageDuration(stageAgeMs)}`,
    `last update ${formatStageDuration(sinceActivityMs)} ago`,
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

/**
 * Main QuickPick entry point + dispatch surface for the Epic Handshake
 * widget. The status bar item registers a command that calls
 * `showMainMenu`; sub-pickers in `menuPickers.ts` route back through
 * `handleAction` via the dispatch callback so every action has exactly
 * one switch.
 *
 * Item factories and lifecycle plumbing live in `menuCommon.ts`.
 */

export async function showMainMenu(opts: { inFlight: boolean }): Promise<void> {
  const paused = isPaused();
  const ws = currentWorkspacePath();
  const lateReplies = ws ? listLateReplies(ws) : [];
  const lateCount = lateReplies.length;
  const currentRecord = ws ? loadBridgeThreadRecord(ws) : null;
  const hasError = (currentRecord?.consecutiveFailures ?? 0) > 0;
  const sessionCounter = currentRecord?.sessionCounter ?? 1;
  // Only show MANAGE CODEX (S<n>) when an active session exists. After
  // delete-all / reset the stored counter holds the projected-next for
  // the upcoming spawn, but showing it as if it's already live confuses
  // users who just cleared their sessions. Matches the submenu's
  // "Created on next prompt to Codex" pattern in `menuPickers.ts` and
  // mirrors how MANAGE OPENCODE / MANAGE LOCAL LLM omit an alias when
  // no session is bound.
  const hasActiveCodexSession =
    currentRecord?.threadId !== null && currentRecord?.threadId !== undefined;

  const pauseItem = makePauseResumeItem(paused, opts.inFlight);
  const cancelItem = makeCancelItem(opts.inFlight);

  // Retrieve always visible. At zero it's informational (friendly
  // toast on click); at >= 1 it opens the late-replies picker which
  // copies each reply to clipboard and clears it from the inbox.
  const retrieveItem: Item = {
    label: `RETRIEVE LATE REPLIES (${lateCount})`,
    description:
      lateCount === 0
        ? "No pending replies right now."
        : "Copies to clipboard and clears the inbox.",
    iconPath: new vscode.ThemeIcon("mail"),
    action: "retrieve",
  };

  // Normalize the read: `currentWaitMode` returns "standard" when
  // neither flag exists on disk, but the menu only exposes ADAPTIVE
  // and FIRE & FORGET. Display STANDARD as ADAPTIVE (the implicit
  // default) so the user never sees an unselectable label, and the
  // toggle on click resolves to FIRE & FORGET as expected.
  const rawCurrent = ws ? currentWaitMode(ws) : "standard";
  const current = rawCurrent === "standard" ? "adaptive" : rawCurrent;
  const next = nextWaitMode(current);
  // Wait mode locks while a turn is in flight. Switching mid-turn
  // would let the in-flight envelope's dispatcher flags go out of
  // sync with the newly-selected mode (Adaptive -> Fire-and-Forget
  // mid-turn leaves the blocking MCP call waiting forever, the
  // reverse direction leaves a fire-and-forget reply stranded). The
  // row stays visible showing the current mode so the user can see
  // it but cannot flip it; action-handler guard enforces the lock
  // even if the click lands between build and handle.
  const waitModeItem: Item | null = paused
    ? null
    : opts.inFlight
      ? {
          label: `WAIT MODE: ${waitModeLabel(current)}`,
          description: "Locked while a bridge turn is running.",
          iconPath: new vscode.ThemeIcon("wat321-square-bolt"),
          action: "wait-mode-locked",
        }
      : {
          label: `WAIT MODE: ${waitModeLabel(current)}`,
          description: `Click to switch to ${waitModeLabel(next)}.`,
          iconPath: new vscode.ThemeIcon("wat321-square-bolt"),
          action: "wait-mode-toggle",
        };

  const sessionsItem: Item = {
    label: hasActiveCodexSession ? `MANAGE CODEX (S${sessionCounter})` : "MANAGE CODEX",
    description: "Switch, reset, delete, or change model settings.",
    iconPath: new vscode.ThemeIcon("wat321-square-info"),
    action: "manage-sessions",
  };

  // Cross-tier entry into OpenCode + Local LLM session management.
  // Hidden when both backends are off so the menu stays lean for users
  // running EH/Codex only. Both sub-pickers live in
  // openCodeSessionsPicker.ts and mirror the Codex menu's row shape
  // (CURRENT/RESET/DELETE/DELETE ALL) on top of the unified bridge's
  // active-alias state.
  const openCodeEnabled = vscode.workspace
    .getConfiguration("wat321")
    .get<boolean>(SETTING.enableOpenCode, true);
  const localEndpoint = vscode.workspace
    .getConfiguration("wat321")
    .get<string>(SETTING.localEndpoint, "")
    .trim();
  // S# suffix on the parent label so the user sees the active session
  // count at a glance, mirroring the Codex menu's `MANAGE CODEX
  // (S<n>)` pattern. The latest alias is read off the unified bridge's
  // session-aliases.json - we show the highest S# present rather than
  // the count, matching how Codex displays the active sessionCounter
  // (the working session).
  const bridgeAliases = readBridgeAliases();
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
  // Local LLM submenu shows only when both OpenCode Routes is enabled
  // AND a local endpoint is configured. Without an endpoint, the
  // local target has nothing to dispatch to and the submenu would
  // be a dead row.
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
          description: "Clears bridge errors, only if there's something to clear.",
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
  // three. Resumes the active S<n> bridge thread on the next prompt;
  // does NOT touch the Codex VS Code extension itself (that would
  // require a full window reload, which we cannot avoid - and which
  // would force a Claude cache LOAD). Always visible because the
  // value is exactly that it works when nothing else does.
  const restartBridgeItem: Item = {
    label: "RESTART EPIC HANDSHAKE BRIDGE",
    description: `Cancel, clear and restart bridge. Resumes (S${sessionCounter}) on next prompt.`,
    iconPath: new vscode.ThemeIcon("sync"),
    action: "restart-bridge",
  };

  // In-flight status appears at the top when a turn is active so the
  // operator sees stage + age + activity gap before scanning down to
  // the action items. Issue #67: distinguishes "still working" from
  // "stuck on flush" without waiting for the 10-minute auto-abort.
  const inFlightStatusItem = opts.inFlight ? makeInFlightStatusItem(ws) : null;

  // Menu ordering: in-flight status (when active), retrieve up top,
  // sessions immediately below it (most-frequent action grouping),
  // wait-mode toggle, conditional clear, restart-bridge as the heavier
  // escalation right above pause, then pause and cancel always at the
  // bottom. Pause and cancel are visible in every menu (including
  // submenus) for consistent escape paths regardless of where the
  // user navigated.
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

  const pick = await withMenuLifecycle(() =>
    vscode.window.showQuickPick(items, {
      title: `WAT321 Epic Handshake${paused ? " (paused)" : ""}`,
      placeHolder: "Choose an action",
    })
  );
  if (!pick) return;

  await handleAction(pick.action, {
    ws,
    lateReplies,
    recoverable: ws ? listRecoverableSessions(ws) : [],
    inFlight: opts.inFlight,
  });
}

/** Single dispatch point for every action any menu can produce.
 * Sub-menus pass this in as their `dispatch` callback so they can
 * route Pause/Resume/Cancel/Back through the same switch. */
async function handleAction(action: Action, ctx: ActionContext): Promise<void> {
  switch (action) {
    case "pause":
      setPaused(true);
      break;
    case "resume":
      setPaused(false);
      break;
    case "reset":
      await vscode.commands.executeCommand(
        "wat321.epicHandshake.resetCodexSession"
      );
      break;
    case "delete":
      await vscode.commands.executeCommand(
        "wat321.epicHandshake.deleteCodexSession"
      );
      break;
    case "delete-all":
      await vscode.commands.executeCommand(
        "wat321.epicHandshake.deleteAllCodexSessions"
      );
      break;
    case "retrieve":
      if (ctx.lateReplies.length === 0) {
        void vscode.window.showInformationMessage(
          "Epic Handshake: inbox is empty. New replies will surface here as they arrive."
        );
      } else {
        await showLateRepliesPicker(ctx.lateReplies, ctx.inFlight, handleAction);
      }
      break;
    case "discard-mail":
      await discardAllLateReplies(ctx.lateReplies);
      break;
    case "recover":
      if (ctx.ws) {
        await showRecoverSessionPicker(
          ctx.ws,
          ctx.recoverable,
          ctx.inFlight,
          handleAction
        );
      }
      break;
    case "clear-error":
      if (ctx.ws) {
        clearBridgeErrorState(ctx.ws);
        void vscode.window.showInformationMessage(
          "Epic Handshake: error state cleared. Widget returns to idle."
        );
      }
      break;
    case "cancel":
      if (!ctx.ws) {
        void vscode.window.showWarningMessage(
          "Epic Handshake: no workspace open; cancel flag cannot be scoped."
        );
        return;
      }
      // Re-check at action time: the menu item is now always visible
      // (so the user can always find it), but if they click it outside
      // of an active turn we just toast "nothing to cancel" and skip
      // the flag write. Writing the flag with no active runTurnOnce
      // to consume it would leave a stale cancel sentinel that would
      // instantly interrupt the NEXT turn.
      if (!isBridgeBusy(ctx.ws)) {
        void vscode.window.showInformationMessage(
          "Epic Handshake: no turn to cancel right now."
        );
        return;
      }
      writeCancelFlag(ctx.ws);
      void vscode.window.showInformationMessage(
        "Epic Handshake: sent interrupt to Codex. Claude receives a \"cancelled by user\" reply within ~1s."
      );
      break;
    case "codex-defaults":
      // Codex Defaults picker: combined sandbox + model + effort
      // entry point. All three are per-turn overrides, so the change
      // takes effect on the next prompt without a thread reset. The
      // picker is locked while a bridge turn is running because the
      // override flags it writes are read mid-turn; switching while
      // a turn is outstanding would mean the in-flight envelope used
      // one set of values while the user expected another.
      if (isBridgeBusy(ctx.ws)) {
        void vscode.window.showInformationMessage(
          "Epic Handshake: Codex Defaults are locked while a bridge turn is running. They will unlock automatically when the turn finishes."
        );
        break;
      }
      await showCodexDefaultsPicker(handleAction, {
        ws: ctx.ws,
        lateReplies: [],
        recoverable: ctx.recoverable,
        inFlight: ctx.inFlight,
      });
      break;
    case "wait-mode-toggle": {
      // Binary toggle between Adaptive and Fire-and-Forget (see
      // `nextWaitMode` in waitMode.ts). Standard mode is internal-only
      // and unreachable from the menu - if currentWaitMode returns
      // "standard" the toggle resolves to FF, and the next click
      // re-grounds the workspace to Adaptive. No toast; the 2500ms
      // bolt-square flash on the status bar is the visual confirmation
      // regardless of which direction the toggle advanced. Flash flag
      // is workspace-scoped so only THIS window flashes; sibling
      // windows ignore.
      //
      // Race guard: a bridge turn may have started between menu
      // build and click. Re-check `isBridgeBusy` here and fall
      // through to the locked toast instead of switching under an
      // in-flight turn, which would desync the dispatcher's wait
      // behavior from the envelope that is already out on the wire.
      if (isBridgeBusy(ctx.ws)) {
        void vscode.window.showInformationMessage(
          "Epic Handshake: wait mode is locked while a bridge turn is running. It will unlock automatically when the turn finishes."
        );
        break;
      }
      if (ctx.ws) {
        applyWaitMode(nextWaitMode(currentWaitMode(ctx.ws)), ctx.ws);
      }
      if (ctx.ws) {
        try {
          writeFileAtomic(
            waitModeFlashFlagPath(workspaceHash(ctx.ws)),
            new Date().toISOString()
          );
        } catch {
          // best-effort
        }
      }
      break;
    }
    case "wait-mode-locked":
      void vscode.window.showInformationMessage(
        "Epic Handshake: wait mode is locked while a bridge turn is running. It will unlock automatically when the turn finishes."
      );
      break;
    case "in-flight-info":
      // Informational only. Re-open the menu so the operator can act
      // on what they just saw (Cancel / Restart Bridge / etc.) without
      // a second click on the widget.
      void showMainMenu({ inFlight: isBridgeBusy(ctx.ws) });
      break;
    case "manage-sessions":
      await showSessionsSubmenu({
        ws: ctx.ws,
        inFlight: ctx.inFlight,
        recoverable: ctx.recoverable,
        dispatch: handleAction,
      });
      break;
    case "manage-opencode-sessions":
      if ((await showOpenCodeSessionsPicker()) === "back") {
        await showMainMenu({ inFlight: isBridgeBusy(ctx.ws) });
      }
      break;
    case "manage-local-llm-sessions":
      if ((await showLocalLLMSessionsPicker()) === "back") {
        await showMainMenu({ inFlight: isBridgeBusy(ctx.ws) });
      }
      break;
    case "repair-sessions":
      await showRepairSessionsPicker(ctx.ws, ctx.recoverable, ctx.inFlight);
      break;
    case "restart-bridge":
      await vscode.commands.executeCommand(
        "wat321.epicHandshake.restartCodexBridge"
      );
      void vscode.window.showInformationMessage(
        "Epic Handshake: bridge restarted. The active session resumes on your next prompt."
      );
      break;
    case "back":
      // Sub-menus invoke this to return to the main menu so the user
      // doesn't have to close + re-click the status bar widget. We
      // re-read inFlight from the flag files so the menu reflects
      // current state, not stale state from when the sub-menu opened.
      await showMainMenu({ inFlight: isBridgeBusy(ctx.ws) });
      break;
  }
}
