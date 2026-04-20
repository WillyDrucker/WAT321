import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { EventHub } from "../engine/eventHub";
import { getWidgetPriority, WIDGET_SLOT } from "../engine/widgetCatalog";
import {
  CANCEL_FLAG_PATH,
  EPIC_HANDSHAKE_DIR,
  FIRE_AND_FORGET_FLAG_PATH,
  INBOX_CODEX_DIR,
  IN_FLIGHT_FLAG_PATH,
  PAUSED_FLAG_PATH,
  PROCESSING_FLAG_PATH,
  RETURNING_FLAG_PATH,
  WAIT_MODE_FLASH_FLAG_PATH,
} from "./constants";
import {
  countPendingLateReplies,
  listLateReplies,
  newestLateReplyAgeMs,
  type LateReply,
} from "./lateReplyInbox";
import {
  bridgeThreadDisplayName,
  clearBridgeErrorState,
  listRecoverableSessions,
  loadBridgeThreadRecord,
  loadBridgeThreadRecordIfExists,
  recoverBridgeThread,
  type RecoverableSession,
} from "./threadPersistence";

function isPaused(): boolean {
  return existsSync(PAUSED_FLAG_PATH);
}

/** Lifecycle hooks the status-bar tooltip suppressor wires in so any
 * menu (main or submenu) it opens flips the tooltip off for the
 * duration of the menu plus a grace window. Module-scoped so
 * sub-menu functions can call openMenu/closeMenu without the
 * status-bar item passing the hooks down through every signature. */
let menuOnOpen: (() => void) | null = null;
let menuOnClose: (() => void) | null = null;

function setMenuLifecycleHooks(hooks: { onOpen: () => void; onClose: () => void }): void {
  menuOnOpen = hooks.onOpen;
  menuOnClose = hooks.onClose;
}

async function withMenuLifecycle<T>(fn: () => Thenable<T>): Promise<T> {
  menuOnOpen?.();
  try {
    return await fn();
  } finally {
    menuOnClose?.();
  }
}

const WAIT_MODE_FLASH_DURATION_MS = 2500;

function readWaitModeFlashStart(): number | null {
  try {
    if (!existsSync(WAIT_MODE_FLASH_FLAG_PATH)) return null;
    const raw = readFileSync(WAIT_MODE_FLASH_FLAG_PATH, "utf8").trim();
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** True if we're inside the 2500ms wait-mode toggle flash window.
 * Lazy-cleans the flag file once the window expires so a stale flash
 * sentinel from a prior session can't ride into the next refresh tick. */
function renderWaitModeFlash(now: number): boolean {
  const start = readWaitModeFlashStart();
  if (start === null) return false;
  if (now - start < WAIT_MODE_FLASH_DURATION_MS) return true;
  try {
    unlinkSync(WAIT_MODE_FLASH_FLAG_PATH);
  } catch {
    // best-effort
  }
  return false;
}

function setPaused(paused: boolean): void {
  if (paused) {
    writeFileSync(PAUSED_FLAG_PATH, new Date().toISOString(), "utf8");
  } else if (existsSync(PAUSED_FLAG_PATH)) {
    unlinkSync(PAUSED_FLAG_PATH);
  }
}

/** A prompt is "in flight" if any envelope sits in inbox/codex/
 * waiting for the dispatcher to process it, OR if bridge-thread
 * tracked lastSuccessAt is stale but lastError also null (active
 * dispatch). Simple heuristic: non-empty inbox/codex/. */
function hasPendingPrompt(_workspacePath: string | null): boolean {
  try {
    if (!existsSync(INBOX_CODEX_DIR)) return false;
    const files = readdirSync(INBOX_CODEX_DIR).filter((f) => f.endsWith(".md"));
    return files.length > 0;
  } catch {
    return false;
  }
}

/**
 * Epic Handshake status bar widget. Renders the bridge state between
 * the Claude and Codex session-token widgets as a three-icon layout:
 * `$(claude) [state] $(openai)`. State priority (first match wins):
 * paused, in-flight, returning, delivered flash, late-reply, error,
 * idle. Click opens a QuickPick menu (retrieve, pause/resume, reset,
 * delete, health). Animation frames derive from wall-clock parity so
 * no dedicated animation timer is needed - the 500ms tier refresh
 * drives every transition.
 */

const COMMAND_ID = "wat321.epicHandshake.manage";

export function createEpicHandshakeStatusBarItem(
  context: vscode.ExtensionContext,
  events: EventHub
): {
  refresh: (opts: { enabled: boolean; workspacePath: string | null }) => void;
  dispose: () => void;
} {
  // Slot 5 in the widget catalog places the bridge between Claude
  // Session Tokens (slot 4) and Codex Session Tokens (slot 6) so the
  // icon visually separates the two providers.
  const item = vscode.window.createStatusBarItem(
    "wat321.epicHandshake",
    vscode.StatusBarAlignment.Right,
    getWidgetPriority(WIDGET_SLOT.epicHandshake)
  );
  item.name = "WAT321 Epic Handshake";
  item.command = COMMAND_ID;
  item.hide();

  // Tooltip suppression: VS Code shows the status bar tooltip on
  // hover, but a click-to-open-menu also flashes it AND it persists
  // on top of any toast the Manage menu fires. Two layers of defense:
  //   1. While any of our QuickPicks is open, fully suppress.
  //   2. After it closes, a 7s grace window so action toasts land
  //      without the tooltip racing in over them.
  let suppressTooltipUntil = 0;
  let menuOpenCount = 0;
  const TOOLTIP_SUPPRESS_MS = 7_000;

  // Exposed via module-scope helpers so submenu re-entries (e.g. the
  // Back button) extend the suppression too without duplicate plumbing.
  setMenuLifecycleHooks({
    onOpen: () => {
      menuOpenCount++;
      suppressTooltipUntil = Number.MAX_SAFE_INTEGER;
      item.tooltip = undefined;
    },
    onClose: () => {
      menuOpenCount = Math.max(0, menuOpenCount - 1);
      if (menuOpenCount === 0) {
        suppressTooltipUntil = Date.now() + TOOLTIP_SUPPRESS_MS;
      }
    },
  });

  const register = vscode.commands.registerCommand(COMMAND_ID, async () => {
    const inFlightNow =
      existsSync(IN_FLIGHT_FLAG_PATH) || existsSync(PROCESSING_FLAG_PATH);
    await showMainMenu({ inFlight: inFlightNow });
  });

  context.subscriptions.push(register, item);

  // Mail pulse state machine: a late reply arriving in inbox/claude/
  // grabs attention with an initial 5-second pulse. Each subsequent
  // completed Claude turn (session.responseComplete event) triggers
  // another pulse, up to 3 total. Rationale: user keeps typing to
  // Claude about unrelated things; pulsing on each turn reminds them
  // a Codex reply is sitting in the bridge inbox. After 3 pulses OR
  // 5 minutes elapsed from arrival (whichever first), the widget
  // returns to idle visually, but the envelope file stays until the
  // dispatcher's 1-hour TTL sweep or a prompt consumes it via
  // collectLateReplies. A newer envelope arriving resets the counter.
  let mailArrivedAt: number | null = null;
  let mailPulseCount = 0;
  let mailPulseStartedAt: number | null = null;
  const MAIL_PULSE_CAP = 3;
  const MAIL_PULSE_DURATION_MS = 5_000;
  const MAIL_VISIBLE_WINDOW_MS = 5 * 60 * 1_000;

  // Subscribe to the engine's response-complete event. Fires once per
  // completed Claude turn. We only increment the pulse counter when
  // mail is actually pending - the subscription is cheap enough to
  // stay live for the lifetime of the widget.
  const responseSub = events.on("session.responseComplete", (p) => {
    if (p.provider !== "claude") return;
    const pending = countPendingLateReplies();
    if (pending === 0) return;
    if (mailArrivedAt === null) return;
    const now = Date.now();
    if (now - mailArrivedAt > MAIL_VISIBLE_WINDOW_MS) return;
    if (mailPulseCount >= MAIL_PULSE_CAP) return;
    // Avoid double-counting rapid consecutive events: require the
    // previous pulse window to have closed before starting a new one.
    if (mailPulseStartedAt !== null && now - mailPulseStartedAt < MAIL_PULSE_DURATION_MS) return;
    mailPulseStartedAt = now;
    mailPulseCount++;
  });

  // Delivered-flash tracking: records the success timestamp the flash
  // locked onto so repeated refreshes during the 2s window render
  // consistently even if lastSuccessAt jitters from a new prompt.
  let deliveredShownAt: number | null = null;

  // Sending-phase start tracker. Enforces a 3000ms floor on the
  // arrow-circle-right animation before the processing (comment-
  // discussion) animation can take over, so brief prompts never
  // skip the "sending" visual cue entirely.
  let sendingStartedAt: number | null = null;
  const SENDING_MIN_MS = 3_000;

  // Claude's default MCP-tool wait (channel.mjs). Keep in sync with
  // the `timeout_sec || 120` default there. Drives the countdown that
  // renders in the sending/processing tooltip so the user can see how
  // much time Claude has left before it gives up on the reply.
  const CLAUDE_WAIT_MS = 120_000;

  function describeWaitMode(): string {
    return existsSync(FIRE_AND_FORGET_FLAG_PATH)
      ? "Wait Mode:\nFire-And-Forget - Claude doesn't wait"
      : "Wait Mode:\nStandard - Claude waits up to 120s";
  }

  function formatRemaining(ms: number): string {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, "0")}`;
  }

  function readInFlightStartMs(): number | null {
    try {
      return statSync(IN_FLIGHT_FLAG_PATH).mtimeMs;
    } catch {
      return null;
    }
  }

  function refresh(opts: { enabled: boolean; workspacePath: string | null }): void {
    if (!opts.enabled) {
      item.hide();
      deliveredShownAt = null;
      return;
    }

    const rec = opts.workspacePath ? loadBridgeThreadRecordIfExists(opts.workspacePath) : null;
    const paused = isPaused();
    const fails = rec?.consecutiveFailures ?? 0;
    const inFlight = existsSync(IN_FLIGHT_FLAG_PATH) || hasPendingPrompt(opts.workspacePath);
    const processing = existsSync(PROCESSING_FLAG_PATH);
    const returning = existsSync(RETURNING_FLAG_PATH);

    // Track sending-phase start so we can enforce a 3s floor. Sending
    // means in-flight but processing hasn't begun yet. When the turn
    // ends (returning or idle) reset the tracker.
    const sendingActive = inFlight && !processing && !returning;
    if (sendingActive && sendingStartedAt === null) {
      sendingStartedAt = Date.now();
    } else if (!inFlight && !processing) {
      sendingStartedAt = null;
    }
    const pendingCount = countPendingLateReplies();
    if (pendingCount === 0 && mailArrivedAt !== null) {
      // Inbox cleared (consumed by a prompt or retrieved manually).
      // Reset pulse state so the next arrival starts with pulse 1.
      mailArrivedAt = null;
      mailPulseCount = 0;
      mailPulseStartedAt = null;
    }
    const now = Date.now();
    const lastSuccessMs = rec?.lastSuccessAt ? new Date(rec.lastSuccessAt).getTime() : 0;
    const justDelivered = lastSuccessMs > 0 && now - lastSuccessMs < 3000;
    if (justDelivered && deliveredShownAt === null) deliveredShownAt = lastSuccessMs;
    if (!justDelivered) deliveredShownAt = null;

    // State priority: paused > bridge-error > in-flight > delivered
    // flash > late-reply > error-sticky > idle. Animation frames use
    // wall-clock parity so no extra timer is needed.
    const oneHz = Math.floor(now / 1000) % 2 === 0;

    let icon: string;
    let tooltip: string;
    const name = opts.workspacePath && rec
      ? bridgeThreadDisplayName(opts.workspacePath, rec.sessionCounter)
      : "Epic Handshake";

    // Honor the 3s sending floor: if processing just kicked in but
    // we have not displayed sending long enough, keep rendering the
    // arrow-circle-right animation so a fast reply does not skip it.
    const sendingElapsed = sendingStartedAt !== null ? now - sendingStartedAt : Infinity;
    const showSendingOverride = processing && sendingElapsed < SENDING_MIN_MS;

    // Countdown appended to the active-turn tooltips so the user can
    // see how long Claude has left before the MCP tool gives up. Only
    // meaningful in Standard mode - Fire-And-Forget returns immediately
    // so there's no deadline to count against.
    const fireAndForget = existsSync(FIRE_AND_FORGET_FLAG_PATH);
    const inFlightStart = readInFlightStartMs();
    const countdownSuffix =
      !fireAndForget && inFlightStart !== null
        ? `\nClaude stops waiting in ${formatRemaining(CLAUDE_WAIT_MS - (now - inFlightStart))}`
        : "";

    if (paused) {
      icon = "$(claude) $(wat321-square-pause) $(openai)";
      tooltip = "Paused. Click to resume.";
    } else if (!returning && (sendingActive || showSendingOverride)) {
      const frame = oneHz ? "$(wat321-square-arrow-right)" : "$(wat321-square)";
      icon = `$(claude) ${frame} $(openai)`;
      tooltip = `${name}\nSending to Codex. Click for options.${countdownSuffix}`;
    } else if (processing) {
      // Pulse info icon on/off at 1Hz against the empty square to keep
      // the status bar cell width constant (no layout shift).
      const frame = oneHz ? "$(wat321-square-info)" : "$(wat321-square)";
      icon = `$(claude) ${frame} $(openai)`;
      tooltip = `${name}\nCodex is working on your request. Click for options.${countdownSuffix}`;
    } else if (returning) {
      // Post-turn latch: the dispatcher holds this flag for 5000ms so
      // the return animation is visible before the delivered flash
      // takes over. Keeps the user from missing what's happening
      // during the reply-transfer phase (~100-500ms of physical travel).
      const frame = oneHz ? "$(wat321-square-arrow-left)" : "$(wat321-square)";
      icon = `$(claude) ${frame} $(openai)`;
      tooltip = `${name}\nReply returning to Claude...`;
    } else if (justDelivered) {
      // Delivered-flash cadence (3000ms total, driven off
      // deliveredShownAt):
      //   0-500   check
      //   500-1000 square
      //   1000-1500 check
      //   1500-2000 square
      //   2000-3000 check (held)
      // After 3000ms, justDelivered clears and we fall through to idle.
      const elapsed = deliveredShownAt !== null ? now - deliveredShownAt : 0;
      const showCheck =
        elapsed < 500 ||
        (elapsed >= 1000 && elapsed < 1500) ||
        elapsed >= 2000;
      const frame = showCheck ? "$(wat321-square-check)" : "$(wat321-square)";
      icon = `$(claude) ${frame} $(openai)`;
      tooltip = `${name}\nReply delivered. Click for options.`;
    } else if (pendingCount > 0) {
      // Track arrival time of the current mail generation. A newer
      // mtime means a fresh envelope landed - reset the pulse state
      // so the user sees the initial pulse + 3 follow-up pulses on
      // the new mail rather than the stale counter from whatever
      // cleared just before.
      const newestAgeMs = newestLateReplyAgeMs();
      const arrivedAt = newestAgeMs !== null ? now - newestAgeMs : now;
      if (mailArrivedAt === null || arrivedAt > mailArrivedAt) {
        mailArrivedAt = arrivedAt;
        mailPulseCount = 1;
        mailPulseStartedAt = arrivedAt;
      }
      const ageFromArrival = now - mailArrivedAt;
      const inPulseWindow =
        mailPulseStartedAt !== null &&
        now - mailPulseStartedAt < MAIL_PULSE_DURATION_MS;
      if (ageFromArrival > MAIL_VISIBLE_WINDOW_MS) {
        // Mail visible window elapsed. Fall through to idle visually;
        // envelope stays on disk for the dispatcher's 1-hour TTL or
        // until a prompt consumes it via collectLateReplies.
        icon = "$(claude) $(wat321-epic-handshake) $(openai)";
        tooltip = `Epic Handshake is ready.\n${pendingCount} late ${pendingCount === 1 ? "reply is" : "replies are"} still in the inbox. They auto-deliver on your next Claude to Codex prompt, or click for options.`;
      } else {
        const mailIcon =
          inPulseWindow && oneHz ? "$(wat321-square-mail-open)" : "$(wat321-square-mail)";
        icon = `$(claude) ${mailIcon} $(openai)`;
        tooltip = `${pendingCount} late ${pendingCount === 1 ? "reply" : "replies"} waiting.\nAuto-delivers on your next Claude to Codex prompt. Click to retrieve manually.`;
      }
    } else if (fails > 0) {
      icon = "$(claude) $(wat321-square-alert) $(openai)";
      const lastErr = rec?.lastError ? `\nLast error: ${rec.lastError.slice(0, 160)}` : "";
      tooltip = `${name}\n${fails} recent failure${fails > 1 ? "s" : ""}. The next successful Claude to Codex prompt clears this automatically, or pick "Clear error state" from the menu to dismiss now.${lastErr}\nClick for options.`;
    } else if (renderWaitModeFlash(now)) {
      // 5-frame bolt/square sequence over 2500ms: bolt 500, square
      // 500, bolt 500, square 500, bolt 500. Fires on any wait-mode
      // toggle so the user sees the toggle take effect without a
      // toast. Falls through to idle on the next tick after the
      // window expires (the flag-file unlink happens lazily here).
      const flashStart = readWaitModeFlashStart();
      const elapsed = flashStart === null ? Infinity : now - flashStart;
      const frame = Math.floor(elapsed / 500) % 2 === 0 ? "$(wat321-square-bolt)" : "$(wat321-square)";
      icon = `$(claude) ${frame} $(openai)`;
      tooltip = fireAndForget
        ? "Epic Handshake: wait mode fire and forget. Claude will not wait for Codex replies."
        : "Epic Handshake: wait mode standard. Claude will wait for Codex replies for up to 2 minutes.";
    } else {
      icon = "$(claude) $(wat321-epic-handshake) $(openai)";
      const lastSuccess = rec?.lastSuccessAt
        ? new Date(rec.lastSuccessAt).toLocaleTimeString()
        : "never";
      tooltip = `${name}\nReady. Last success: ${lastSuccess}\nClick for options.`;
    }

    // Append the current wait mode to every tooltip so the user can
    // always confirm it at a glance. Paused state skips the suffix
    // because the mode is moot while the bridge isn't taking prompts.
    if (!paused) {
      tooltip += `\n\n${describeWaitMode()}`;
    }

    item.text = icon;
    // Tooltip shows the current state on hover, but is cleared for a
    // short window after a click so it doesn't cover the toasts the
    // Manage menu fires (pause/resume/recover/etc). See the click
    // handler above for the suppression timer.
    item.tooltip = now < suppressTooltipUntil ? undefined : tooltip;
    item.show();
  }

  return {
    refresh,
    dispose: () => {
      responseSub.dispose();
      item.dispose();
    },
  };
}

/** All user-facing actions that any menu (main or submenu) can fire.
 * Declared once here so helper factories can produce items with the
 * correct action type and sub-menus carry through without drift. */
type Action =
  | "reset"
  | "delete"
  | "pause"
  | "resume"
  | "retrieve"
  | "discard-mail"
  | "recover"
  | "clear-error"
  | "cancel"
  | "wait-mode-toggle"
  | "manage-sessions"
  | "back";

type Item = vscode.QuickPickItem & { action: Action };

/** Pause/Resume factory. Carried through sub-menus so the user can
 * pause without navigating back. Yellow icon color flags this as a
 * "soft state toggle" vs the destructive actions below. Hidden when
 * a turn is in-flight so the user can't pause mid-dispatch - they
 * have to Cancel first. */
function makePauseResumeItem(paused: boolean, inFlight: boolean): Item | null {
  if (!paused && inFlight) return null;
  return paused
    ? {
        label: "Resume bridge",
        description: "Re-enable Claude to Codex prompts.",
        iconPath: new vscode.ThemeIcon("wat321-square-play", new vscode.ThemeColor("charts.yellow")),
        action: "resume",
      }
    : {
        label: "Pause bridge",
        description: "Block new prompts until you resume.",
        iconPath: new vscode.ThemeIcon("wat321-square-pause", new vscode.ThemeColor("charts.yellow")),
        action: "pause",
      };
}

/** Cancel factory. Carried through sub-menus. Red icon flags this as
 * the destructive stop-the-world action. Only present while a turn
 * is actually in-flight. */
function makeCancelItem(inFlight: boolean): Item | null {
  if (!inFlight) return null;
  return {
    label: "Cancel in-flight prompt",
    description: "Ask Codex to stop the current turn.",
    detail:
      "Sends interrupt. Codex stops before next model round. Claude gets a \"cancelled by user\" reply within ~1s.",
    iconPath: new vscode.ThemeIcon("wat321-square-error", new vscode.ThemeColor("charts.red")),
    action: "cancel",
  };
}

/** Back-to-main-menu navigation item for sub-menus. */
function makeBackItem(): Item {
  return {
    label: "Back",
    description: "Return to the main menu.",
    iconPath: new vscode.ThemeIcon("wat321-square-arrow-left"),
    action: "back",
  };
}

async function showMainMenu(opts: { inFlight: boolean }): Promise<void> {
  const paused = isPaused();
  const lateReplies = listLateReplies();
  const lateCount = lateReplies.length;
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const currentRecord = ws ? loadBridgeThreadRecord(ws) : null;
  const hasError = (currentRecord?.consecutiveFailures ?? 0) > 0;
  const fireAndForget = existsSync(FIRE_AND_FORGET_FLAG_PATH);
  const sessionCounter = currentRecord?.sessionCounter ?? 1;

  const pauseItem = makePauseResumeItem(paused, opts.inFlight);
  const cancelItem = makeCancelItem(opts.inFlight);

  // Retrieve always visible. At zero it's informational (friendly
  // toast on click); at >= 1 it opens the late-replies picker.
  const retrieveItem: Item = {
    label: `Retrieve late replies (${lateCount})`,
    description:
      lateCount === 0
        ? "No pending replies right now."
        : "Codex replies that arrived after a prompt timed out.",
    detail:
      lateCount === 0
        ? "When Codex replies to a timed-out prompt, you can read it here."
        : "Pick one to copy to clipboard.",
    iconPath: new vscode.ThemeIcon("wat321-square-mail"),
    action: "retrieve",
  };

  const waitModeItem: Item | null = paused
    ? null
    : {
        label: `Wait mode: ${fireAndForget ? "Fire and forget" : "Standard (2 min)"}`,
        description: "Click to switch.",
        detail: fireAndForget
          ? "Claude's tool returns immediately; reply lands in inbox when ready."
          : "Claude blocks up to 2 min per prompt. Click for fire-and-forget.",
        iconPath: new vscode.ThemeIcon("wat321-square-bolt"),
        action: "wait-mode-toggle",
      };

  const sessionsItem: Item = {
    label: `Manage Codex Sessions (S${sessionCounter})`,
    description: "Reset, delete, or recover.",
    detail: "Opens a submenu for Codex session controls.",
    iconPath: new vscode.ThemeIcon("wat321-square-arrow-right"),
    action: "manage-sessions",
  };

  const clearErrorItem: Item | null =
    hasError && !paused
      ? {
          label: "Clear error state",
          description: "Dismiss the red icon without rotating thread.",
          detail: currentRecord?.lastError
            ? `Last error: ${currentRecord.lastError.slice(0, 120)}`
            : "Resets the failure counter. If next prompt also fails, pick Reset from Manage Codex Sessions.",
          iconPath: new vscode.ThemeIcon("wat321-square-check"),
          action: "clear-error",
        }
      : null;

  const items: Item[] = [
    ...(pauseItem ? [pauseItem] : []),
    retrieveItem,
    ...(waitModeItem ? [waitModeItem] : []),
    sessionsItem,
    ...(clearErrorItem ? [clearErrorItem] : []),
    ...(cancelItem ? [cancelItem] : []),
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

async function showSessionsSubmenu(opts: {
  ws: string | undefined;
  inFlight: boolean;
  recoverable: RecoverableSession[];
}): Promise<void> {
  const paused = isPaused();
  const pauseItem = makePauseResumeItem(paused, opts.inFlight);
  const cancelItem = makeCancelItem(opts.inFlight);

  const resetItem: Item = {
    label: "Reset Codex Session (Soft)",
    description: "Bump counter; fresh session on next prompt.",
    detail: "Keeps the old Codex session visible in Codex's own history.",
    iconPath: new vscode.ThemeIcon("refresh"),
    action: "reset",
  };

  const deleteItem: Item = {
    label: "Delete Codex Session",
    description: "Permanent. Fresh session on next prompt.",
    detail: "Removes the rollout file and strips the index entry.",
    iconPath: new vscode.ThemeIcon("trash"),
    action: "delete",
  };

  const recoverItem: Item | null =
    opts.recoverable.length > 0
      ? {
          label: `Recover Codex Session (${opts.recoverable.length})`,
          description: "Reattach to a prior Epic Handshake session.",
          detail: "Stale entries (rollout deleted) are filtered out.",
          iconPath: new vscode.ThemeIcon("history"),
          action: "recover",
        }
      : null;

  const items: Item[] = [
    ...(pauseItem ? [pauseItem] : []),
    makeBackItem(),
    resetItem,
    deleteItem,
    ...(recoverItem ? [recoverItem] : []),
    ...(cancelItem ? [cancelItem] : []),
  ];

  const pick = await withMenuLifecycle(() =>
    vscode.window.showQuickPick(items, {
      title: `Manage Codex Sessions${paused ? " (paused)" : ""}`,
      placeHolder: "Choose an action",
    })
  );
  if (!pick) return;

  await handleAction(pick.action, {
    ws: opts.ws,
    lateReplies: [],
    recoverable: opts.recoverable,
    inFlight: opts.inFlight,
  });
}

/** Single dispatch point for every action any menu can produce.
 * Sub-menus route through here rather than duplicating the switch. */
async function handleAction(
  action: Action,
  ctx: {
    ws: string | undefined;
    lateReplies: LateReply[];
    recoverable: RecoverableSession[];
    inFlight: boolean;
  }
): Promise<void> {
  switch (action) {
    case "pause":
      setPaused(true);
      break;
    case "resume":
      setPaused(false);
      break;
    case "reset":
      await vscode.commands.executeCommand("wat321.epicHandshake.resetCodexSession");
      break;
    case "delete":
      await vscode.commands.executeCommand("wat321.epicHandshake.deleteCodexSession");
      break;
    case "retrieve":
      if (ctx.lateReplies.length === 0) {
        void vscode.window.showInformationMessage(
          "Epic Handshake: inbox is empty. New replies will surface here as they arrive."
        );
      } else {
        await showLateRepliesPicker(ctx.lateReplies, ctx.inFlight);
      }
      break;
    case "discard-mail":
      await discardAllLateReplies(ctx.lateReplies);
      break;
    case "recover":
      if (ctx.ws) await showRecoverSessionPicker(ctx.ws, ctx.recoverable, ctx.inFlight);
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
      try {
        writeFileSync(CANCEL_FLAG_PATH, new Date().toISOString(), "utf8");
        void vscode.window.showInformationMessage(
          "Epic Handshake: sent interrupt to Codex. Claude receives a \"cancelled by user\" reply within ~1s."
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(
          `Epic Handshake: could not write cancel flag: ${msg}`
        );
      }
      break;
    case "wait-mode-toggle": {
      // No toast: visual feedback comes from a 2500ms bolt-square
      // flash on the status bar widget (5 frames @ 500ms each driven
      // by the WAIT_MODE_FLASH_FLAG mtime). Flash fires for both
      // directions so the user sees the toggle take effect even when
      // the icon family is otherwise unchanged.
      const currentlyOn = existsSync(FIRE_AND_FORGET_FLAG_PATH);
      try {
        if (currentlyOn) {
          unlinkSync(FIRE_AND_FORGET_FLAG_PATH);
        } else {
          writeFileSync(FIRE_AND_FORGET_FLAG_PATH, new Date().toISOString(), "utf8");
        }
        writeFileSync(WAIT_MODE_FLASH_FLAG_PATH, new Date().toISOString(), "utf8");
      } catch {
        // best-effort; the next refresh tick will reflect whichever
        // state the file write actually achieved
      }
      break;
    }
    case "manage-sessions":
      await showSessionsSubmenu({
        ws: ctx.ws,
        inFlight: ctx.inFlight,
        recoverable: ctx.recoverable,
      });
      break;
    case "back":
      // Sub-menus invoke this to return to the main menu so the user
      // doesn't have to close + re-click the status bar widget. We
      // re-read inFlight from the flag files so the menu reflects
      // current state, not stale state from when the sub-menu opened.
      await showMainMenu({
        inFlight:
          existsSync(IN_FLIGHT_FLAG_PATH) || existsSync(PROCESSING_FLAG_PATH),
      });
      break;
  }
}

async function showRecoverSessionPicker(
  workspacePath: string,
  sessions: RecoverableSession[],
  inFlight: boolean
): Promise<void> {
  if (sessions.length === 0) return;
  const current = loadBridgeThreadRecord(workspacePath);
  const paused = isPaused();
  const pauseItem = makePauseResumeItem(paused, inFlight);
  const cancelItem = makeCancelItem(inFlight);

  type RecoverPick =
    | (vscode.QuickPickItem & { rowKind: "session"; session: RecoverableSession })
    | (vscode.QuickPickItem & { rowKind: "action"; action: Action });

  const sessionItems: RecoverPick[] = sessions.map((s) => {
    const isActive = s.threadId === current.threadId;
    const item: RecoverPick = {
      rowKind: "session",
      label: `S${s.sessionCounter}${isActive ? " (current)" : ""}`,
      detail: `${s.displayName} - thread ${s.threadId.slice(0, 12)}...`,
      session: s,
    };
    if (s.createdAt) item.description = new Date(s.createdAt).toLocaleString();
    return item;
  });

  const items: RecoverPick[] = [
    ...(pauseItem ? [{ ...pauseItem, rowKind: "action" as const }] : []),
    { ...makeBackItem(), rowKind: "action" as const },
    ...sessionItems,
    ...(cancelItem ? [{ ...cancelItem, rowKind: "action" as const }] : []),
  ];

  const pick = await withMenuLifecycle(() =>
    vscode.window.showQuickPick<RecoverPick>(items, {
      title: `Recover Codex Session${paused ? " (paused)" : ""}`,
      placeHolder: "Pick a previous Codex session to reattach the bridge to",
    })
  );
  if (!pick) return;

  if (pick.rowKind === "action") {
    await handleAction(pick.action, {
      ws: workspacePath,
      lateReplies: [],
      recoverable: sessions,
      inFlight,
    });
    return;
  }

  if (pick.session.threadId === current.threadId) {
    void vscode.window.showInformationMessage(
      `Epic Handshake: already attached to S${pick.session.sessionCounter}.`
    );
    return;
  }
  recoverBridgeThread(workspacePath, pick.session);
  void vscode.window.showInformationMessage(
    `Epic Handshake: reattached to S${pick.session.sessionCounter}. Next Claude to Codex prompt resumes this session.`
  );
}

async function discardAllLateReplies(replies: LateReply[]): Promise<void> {
  if (replies.length === 0) return;
  const label = `Discard ${replies.length} late ${replies.length > 1 ? "replies" : "reply"}?`;
  const confirm = await vscode.window.showWarningMessage(
    label,
    {
      modal: true,
      detail:
        "Replies move out of the inbox unread, so nothing auto-delivers on your next Claude to Codex prompt. Files stay in sent/ until the 1-hour sweep if you change your mind.",
    },
    "Discard"
  );
  if (confirm !== "Discard") return;

  const sentDir = join(EPIC_HANDSHAKE_DIR, "sent", "claude");
  if (!existsSync(sentDir)) mkdirSync(sentDir, { recursive: true });
  let moved = 0;
  for (const r of replies) {
    try {
      renameSync(r.fullPath, join(sentDir, r.filename));
      moved++;
    } catch {
      // best-effort
    }
  }
  void vscode.window.showInformationMessage(
    `Discarded ${moved} late ${moved === 1 ? "reply" : "replies"}.`
  );
}

async function showLateRepliesPicker(
  initialReplies: LateReply[],
  inFlight: boolean
): Promise<void> {
  // Loop so the user can retrieve multiple replies without re-opening
  // the main menu between each. Re-reads the inbox each iteration so
  // any reply that arrived while the picker was open surfaces too.
  let replies = initialReplies;
  while (replies.length > 0) {
    const paused = isPaused();
    const pauseItem = makePauseResumeItem(paused, inFlight);
    const cancelItem = makeCancelItem(inFlight);

    type RepliesPick =
      | (vscode.QuickPickItem & { rowKind: "reply"; reply: LateReply })
      | (vscode.QuickPickItem & { rowKind: "action"; action: Action });

    const replyItems: RepliesPick[] = replies.map((r) => ({
      rowKind: "reply",
      label: `${r.intent} reply (${r.sizeKb} KB)`,
      description: r.createdAt ? new Date(r.createdAt).toLocaleTimeString() : "",
      detail: r.body.slice(0, 200).replace(/\s+/g, " ") + (r.body.length > 200 ? "..." : ""),
      iconPath: new vscode.ThemeIcon("wat321-square-mail"),
      reply: r,
    }));

    const discardItem: RepliesPick = {
      rowKind: "action",
      label: `Discard all remaining (${replies.length})`,
      description: "Clear the inbox without reading.",
      detail: "Confirmation required.",
      iconPath: new vscode.ThemeIcon("trash"),
      action: "discard-mail",
    };

    const items: RepliesPick[] = [
      ...(pauseItem ? [{ ...pauseItem, rowKind: "action" as const }] : []),
      { ...makeBackItem(), rowKind: "action" as const },
      ...replyItems,
      discardItem,
      ...(cancelItem ? [{ ...cancelItem, rowKind: "action" as const }] : []),
    ];

    const pick = await withMenuLifecycle(() =>
      vscode.window.showQuickPick<RepliesPick>(items, {
        title: `Late Codex replies (${replies.length})${paused ? " - paused" : ""}`,
        placeHolder: "Pick a reply to copy, or choose an action",
      })
    );
    if (!pick) return;

    if (pick.rowKind === "action") {
      await handleAction(pick.action, {
        ws: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        lateReplies: replies,
        recoverable: [],
        inFlight,
      });
      // Pause/Resume/Cancel: user's done with retrieval for now.
      // Discard: handler already cleared; exit.
      return;
    }

    await vscode.env.clipboard.writeText(pick.reply.body);

    // Move envelope out of inbox so the mail icon clears and the
    // next refresh does not re-surface the same reply.
    try {
      const sentDir = join(EPIC_HANDSHAKE_DIR, "sent", "claude");
      if (!existsSync(sentDir)) mkdirSync(sentDir, { recursive: true });
      renameSync(pick.reply.fullPath, join(sentDir, pick.reply.filename));
    } catch {
      // best-effort
    }

    void vscode.window.showInformationMessage(
      `Reply copied to clipboard (${pick.reply.sizeKb} KB). Paste into your Claude prompt to share it with Claude.`
    );

    // Refresh and loop so remaining replies stay accessible.
    replies = listLateReplies();
  }
}
