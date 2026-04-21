import { existsSync, readFileSync, unlinkSync } from "node:fs";
import * as vscode from "vscode";
import type { EventHub } from "../engine/eventHub";
import { getWidgetPriority, WIDGET_SLOT } from "../engine/widgetCatalog";
import {
  processingFlagPath,
  returningFlagPath,
  waitModeFlashFlagPath,
} from "./constants";
import { countPendingLateReplies, newestLateReplyAgeMs } from "./lateReplyInbox";
import { loadBridgeThreadRecordIfExists, bridgeThreadDisplayName } from "./threadPersistence";
import { workspaceHash } from "./workspaceHash";

// Wait mode, heartbeat reading, stage helpers, menu surface, and the
// shared workspace utilities all live in dedicated files so this
// module only owns the widget shell + refresh loop + tooltip
// suppression plumbing. Re-export the wait mode setters that
// index.ts wires at activate time so callers outside this folder
// still have a single import path.
export { applyDefaultWaitMode, parseDefaultWaitMode } from "./waitMode";

import {
  currentWaitMode,
  isAdaptive,
  waitModeDetail,
  waitModeLabel,
} from "./waitMode";
import {
  applyStageLatch,
  latchTickNoHeartbeat,
  readNewestHeartbeat,
  stageGlyph,
} from "./turnHeartbeat";
import {
  currentWorkspacePath,
  isBridgeBusy,
  isPaused,
} from "./statusBarState";
import {
  setMenuLifecycleHooks,
  showMainMenu,
} from "./statusBarMenus";

const WAIT_MODE_FLASH_DURATION_MS = 2500;

function readWaitModeFlashStart(wsHash: string | null): number | null {
  if (!wsHash) return null;
  const path = waitModeFlashFlagPath(wsHash);
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8").trim();
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** True if we're inside the 2500ms wait-mode toggle flash window.
 * Lazy-cleans the flag file once the window expires so a stale flash
 * sentinel from a prior session can't ride into the next refresh tick. */
function renderWaitModeFlash(now: number, wsHash: string | null): boolean {
  const start = readWaitModeFlashStart(wsHash);
  if (start === null) return false;
  if (now - start < WAIT_MODE_FLASH_DURATION_MS) return true;
  if (wsHash) {
    try {
      unlinkSync(waitModeFlashFlagPath(wsHash));
    } catch {
      // best-effort
    }
  }
  return false;
}

/**
 * Epic Handshake status bar widget. Renders the bridge state between
 * the Claude and Codex session-token widgets as a three-icon layout:
 * `$(claude) [state] $(openai)`. State priority (first match wins):
 * paused, in-flight, returning, delivered flash, late-reply, error,
 * idle. Click opens a QuickPick menu (retrieve, pause/resume, reset,
 * delete, health). Animation frames derive from wall-clock parity so
 * no dedicated animation timer is needed - the 1000ms tier refresh
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

  // Tooltip suppression + write dedup. VS Code reshows the tooltip
  // whenever `item.tooltip` is reassigned if the mouse is hovering,
  // and QuickPick close briefly refocuses the status bar item during
  // which an assignment re-triggers the overlay. Two layers:
  //   1. While any QuickPick is open, fully suppress (tooltip = undefined).
  //   2. After close, a short 1s grace window so the action toast the
  //      menu fires lands without the tooltip racing in over it.
  //   3. Dedup every assignment on (text, tooltip, color) so a 1000ms
  //      tick with identical state never re-renders the overlay.
  let suppressTooltipUntil = 0;
  let menuOpenCount = 0;
  /** How long the tooltip stays suppressed after any menu closes.
   * The window needs to cover the full lifetime of the information/
   * warning toasts action handlers raise, otherwise the next refresh
   * tick reassigns `item.tooltip` and VS Code reshows the hover
   * overlay on top of the toast. VS Code's default toast visibility
   * is ~4s; 5s covers it with a small buffer. */
  const TOOLTIP_SUPPRESS_MS = 5_000;
  let lastText: string | undefined;
  let lastTooltip: string | undefined;
  let lastColor: vscode.ThemeColor | undefined;

  setMenuLifecycleHooks({
    onOpen: () => {
      menuOpenCount++;
      suppressTooltipUntil = Number.MAX_SAFE_INTEGER;
      if (lastTooltip !== undefined) {
        item.tooltip = undefined;
        lastTooltip = undefined;
      }
    },
    onClose: (picked: boolean) => {
      menuOpenCount = Math.max(0, menuOpenCount - 1);
      if (menuOpenCount === 0) {
        // Always tear down the open-time MAX_SAFE_INTEGER suppress
        // when the last menu closes - even on dismissal. Otherwise
        // a cancelled menu would leave suppress stuck at infinity
        // and the tooltip would never re-appear on hover (real bug
        // observed in v1.2.1 testing where users found the tooltip
        // "stopped working" after a couple minutes - they had
        // dismissed a menu earlier, infinity-suppress survived).
        if (picked) {
          // Action picked: keep suppressed for 5s so the action
          // toast plays out without the tooltip overlay covering it.
          suppressTooltipUntil = Date.now() + TOOLTIP_SUPPRESS_MS;
        } else {
          // Cancelled / dismissed: no toast incoming, so let the
          // tooltip be live again immediately.
          suppressTooltipUntil = 0;
        }
        if (lastTooltip !== undefined) {
          item.tooltip = undefined;
          lastTooltip = undefined;
        }
      }
    },
  });

  const register = vscode.commands.registerCommand(COMMAND_ID, async () => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    await showMainMenu({ inFlight: isBridgeBusy(ws) });
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
    const ws = currentWorkspacePath();
    if (!ws) return;
    const pending = countPendingLateReplies(ws);
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
  /** Envelope the widget is currently walking through stages for.
   * Tracked so the walker can keep advancing after the dispatcher
   * cleans up the heartbeat file (delayed 15s in turnRunner) -
   * otherwise reaching stage 5 would require the file to still be
   * around at the moment the walker is ready to show complete. */
  let lastEnvelopeId: string | null = null;
  /** Wall-clock time the walker first reached stage=complete via the
   * synthetic no-heartbeat path. 3s after that the walker is done
   * and we stop producing synthetic heartbeats. */
  let completeWalkDoneAt: number | null = null;
  const SENDING_MIN_MS = 3_000;

  function describeWaitMode(): string {
    const mode = currentWaitMode();
    return `Wait Mode:\n${waitModeLabel(mode)} - ${waitModeDetail(mode)}`;
  }

  function refresh(opts: { enabled: boolean; workspacePath: string | null }): void {
    if (!opts.enabled) {
      item.hide();
      deliveredShownAt = null;
      return;
    }

    const wsHash = opts.workspacePath ? workspaceHash(opts.workspacePath) : null;
    const rec = opts.workspacePath ? loadBridgeThreadRecordIfExists(opts.workspacePath) : null;
    const paused = isPaused();
    const fails = rec?.consecutiveFailures ?? 0;
    const inFlight = isBridgeBusy(opts.workspacePath);
    const processing = wsHash ? existsSync(processingFlagPath(wsHash)) : false;
    const returning = wsHash ? existsSync(returningFlagPath(wsHash)) : false;

    // Track sending-phase start so we can enforce a 3s floor. Sending
    // means in-flight but processing hasn't begun yet. When the turn
    // ends (returning or idle) reset the tracker.
    const sendingActive = inFlight && !processing && !returning;
    if (sendingActive && sendingStartedAt === null) {
      sendingStartedAt = Date.now();
    } else if (!inFlight && !processing) {
      sendingStartedAt = null;
    }
    const pendingCount = opts.workspacePath
      ? countPendingLateReplies(opts.workspacePath)
      : 0;
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

    // Countdown removed from tooltip per user preference - per-stage
    // elapsed + completion times in the static stage block are the
    // load-bearing time signals now. One less second-by-second string
    // change means the tooltip rebuilds less often, which is the only
    // mitigation we have for VS Code's MarkdownString reshow-on-
    // reassignment limitation.

    // Adaptive mode: heartbeat tells us exactly which of the 5 canonical
    // stages the dispatcher sees. Overrides the classic sending/processing
    // glyphs with numbered-square stages + adds plan/tool detail to the
    // tooltip. Standard and Fire-and-Forget modes skip the override so
    // existing visuals stay unchanged.
    const adaptive = isAdaptive();
    const wsHashForHeartbeat = opts.workspacePath
      ? workspaceHash(opts.workspacePath)
      : null;
    const rawHeartbeat = adaptive
      ? readNewestHeartbeat(wsHashForHeartbeat)
      : null;
    // Stage walker: advances one stage at a time per refresh tick,
    // honoring per-stage 3s minimum display. Even when the dispatcher
    // skips stages (common - monitor jumps 3 -> complete in one
    // poll when final_answer + task_complete land in the same 5s
    // window), the walker steps through every stage so the user sees
    // 1/5, 2/5, 3/5, 4/5, 5/5 in order. When the heartbeat file has
    // been cleaned up but we were walking the current envelope, keep
    // feeding the walker a synthetic "complete" target so it can
    // finish reaching stage 5 before giving up.
    let heartbeat: ReturnType<typeof applyStageLatch> | null;
    if (rawHeartbeat) {
      heartbeat = applyStageLatch(rawHeartbeat);
      lastEnvelopeId = rawHeartbeat.envelopeId;
    } else if (lastEnvelopeId !== null) {
      const walker = latchTickNoHeartbeat(lastEnvelopeId);
      if (walker && walker.stage !== "complete") {
        heartbeat = walker;
      } else {
        // Reached the terminal "complete" walk step; stop walking so
        // the widget transitions to the returning-arrow animation.
        heartbeat = walker;
        if (walker && walker.stage === "complete") {
          // Next tick will find no fresh rawHeartbeat, latchState
          // stays at complete, walker returns the same synthetic.
          // Clear lastEnvelopeId after a bit so we stop producing
          // synthetic heartbeats indefinitely.
          if (completeWalkDoneAt === null) completeWalkDoneAt = Date.now();
          if (Date.now() - completeWalkDoneAt > 3000) {
            lastEnvelopeId = null;
            completeWalkDoneAt = null;
            heartbeat = null;
          }
        } else {
          completeWalkDoneAt = null;
        }
      }
    } else {
      heartbeat = null;
    }
    // Tooltip is intentionally static now - no live counters, no
    // per-stage block, no tool counts. Reason: VS Code's
    // StatusBarItem.tooltip reshows the hover overlay every time the
    // string is reassigned with a different value (Issue #128887,
    // open since 2021, no API workaround). With live counters the
    // tooltip changed every few seconds during a turn and the
    // overlay reshow would cover action toasts and feel like a
    // popup. Stripping live data eliminates the reshow trigger
    // entirely - the tooltip now only changes when the workspace
    // identity changes (essentially never during normal use).
    // Live status info still available via the click menu.
    const phaseDetailSuffix = "";

    // In adaptive mode, the stage walker is the source of truth for
    // what's shown during the turn. It takes priority over the
    // returning / sending / processing legacy branches so stages 4
    // and 5 stay visible - previously the dispatcher's returning
    // flag (set at turn end with a 5s latch) would cut the walker
    // off at whatever stage was displayed, typically stage 3 because
    // the monitor jumps working -> complete in one poll.
    const walkerActive =
      adaptive && heartbeat !== null && lastEnvelopeId !== null;

    if (paused) {
      icon = "$(wat321-square-pause)";
      tooltip = "Paused. Click to resume.";
    } else if (walkerActive && heartbeat !== null) {
      // Walker drives the glyph regardless of which flags the
      // dispatcher has set. When the walker reaches stage 5 and its
      // 3s hold expires, lastEnvelopeId clears and this branch goes
      // inactive - the widget then falls into the returning / idle
      // branches below for the handoff animation.
      icon = stageGlyph(heartbeat.stage);
      const phaseCopy =
        heartbeat.stage === "complete"
          ? "Reply finished; handing back to Claude."
          : processing
            ? "Codex is working on your request. Click for options."
            : "Sending to Codex. Click for options.";
      tooltip = `${name}\n${phaseCopy}${phaseDetailSuffix}`;
    } else if (!returning && (sendingActive || showSendingOverride)) {
      // Adaptive heartbeat takes precedence over the classic arrow
      // animation once the dispatcher has stage info to share.
      // Fallback to stage=dispatched glyph when adaptive mode is on
      // but no heartbeat file exists yet - this window covers the
      // pre-turn pipeline (envelope read, client spawn, thread/start
      // or thread/resume RPC) which can be 5-10s on cold start.
      // Without this fallback the status bar would render the arrow
      // animation and the user would miss stage 1 entirely.
      const useStageGlyph = adaptive;
      const frame = useStageGlyph
        ? stageGlyph(heartbeat?.stage ?? "dispatched")
        : oneHz
          ? "$(wat321-square-arrow-right)"
          : "$(wat321-square)";
      icon = frame;
      tooltip = `${name}\nSending to Codex. Click for options.${phaseDetailSuffix}`;
    } else if (processing) {
      // Pulse info icon on/off at 1Hz against the empty square to keep
      // the status bar cell width constant (no layout shift). Adaptive
      // mode overrides with the numbered stage glyph; if somehow no
      // heartbeat landed yet, fall back to stage=dispatched so the
      // widget stays on the glyph track rather than switching frames.
      const useStageGlyph = adaptive;
      const frame = useStageGlyph
        ? stageGlyph(heartbeat?.stage ?? "dispatched")
        : oneHz
          ? "$(wat321-square-info)"
          : "$(wat321-square)";
      icon = frame;
      tooltip = `${name}\nCodex is working on your request. Click for options.${phaseDetailSuffix}`;
    } else if (returning) {
      // Post-turn latch: the dispatcher holds this flag for 5000ms so
      // the return animation is visible before the delivered flash
      // takes over. Keeps the user from missing what's happening
      // during the reply-transfer phase (~100-500ms of physical travel).
      const frame = oneHz ? "$(wat321-square-arrow-left)" : "$(wat321-square)";
      icon = frame;
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
      icon = frame;
      tooltip = `${name}\nReply delivered. Click for options.`;
    } else if (pendingCount > 0) {
      // Track arrival time of the current mail generation. A newer
      // mtime means a fresh envelope landed - reset the pulse state
      // so the user sees the initial pulse + 3 follow-up pulses on
      // the new mail rather than the stale counter from whatever
      // cleared just before.
      const newestAgeMs = opts.workspacePath
        ? newestLateReplyAgeMs(opts.workspacePath)
        : null;
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
        icon = "$(wat321-epic-handshake)";
        tooltip = `Epic Handshake is ready.\n${pendingCount} late ${pendingCount === 1 ? "reply is" : "replies are"} still in the inbox. They auto-deliver on your next Claude to Codex prompt, or click for options.`;
      } else {
        const mailIcon =
          inPulseWindow && oneHz ? "$(wat321-square-mail-open)" : "$(wat321-square-mail)";
        icon = mailIcon;
        tooltip = `${pendingCount} late ${pendingCount === 1 ? "reply" : "replies"} waiting.\nAuto-delivers on your next Claude to Codex prompt. Click to retrieve manually.`;
      }
    } else if (fails > 0) {
      icon = "$(wat321-square-alert)";
      const lastErr = rec?.lastError ? `\nLast error: ${rec.lastError.slice(0, 160)}` : "";
      tooltip = `${name}\n${fails} recent failure${fails > 1 ? "s" : ""}. The next successful Claude to Codex prompt clears this automatically, or pick "Clear error state" from the menu to dismiss now.${lastErr}\nClick for options.`;
    } else if (renderWaitModeFlash(now, wsHash)) {
      // 5-frame bolt/square sequence over 2500ms: bolt 500, square
      // 500, bolt 500, square 500, bolt 500. Fires on any wait-mode
      // toggle so the user sees the toggle take effect without a
      // toast. Falls through to idle on the next tick after the
      // window expires (the flag-file unlink happens lazily here).
      const flashStart = readWaitModeFlashStart(wsHash);
      const elapsed = flashStart === null ? Infinity : now - flashStart;
      const frame = Math.floor(elapsed / 500) % 2 === 0 ? "$(wat321-square-bolt)" : "$(wat321-square)";
      icon = frame;
      const flashMode = currentWaitMode();
      tooltip = `Epic Handshake: ${waitModeLabel(flashMode)}. ${waitModeDetail(flashMode)}`;
    } else {
      icon = "$(wat321-epic-handshake)";
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

    // Dedup every property write. VS Code rerenders the tooltip overlay
    // on `item.tooltip` reassignment even when the value is unchanged,
    // which is what caused the hover-blink during countdown ticks and
    // the flash-on-click after menu close. Only write when the value
    // actually differs from the last tick.
    if (icon !== lastText) {
      item.text = icon;
      lastText = icon;
    }
    const desiredTooltip = now < suppressTooltipUntil ? undefined : tooltip;
    if (desiredTooltip !== lastTooltip) {
      item.tooltip = desiredTooltip;
      lastTooltip = desiredTooltip;
    }
    // Epic Handshake widget does not set `color` today, but future
    // color-coded states (error red, active blue) should flow through
    // this dedup too. Keep the branch wired so the invariant is "no
    // property write on a tick with no change."
    const desiredColor: vscode.ThemeColor | undefined = undefined;
    if (desiredColor !== lastColor) {
      item.color = desiredColor;
      lastColor = desiredColor;
    }
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

