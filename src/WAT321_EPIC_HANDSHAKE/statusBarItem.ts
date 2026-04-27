import { existsSync, readFileSync, unlinkSync } from "node:fs";
import * as vscode from "vscode";
import type { EventHub } from "../engine/eventHub";
import { getWidgetPriority, WIDGET_SLOT } from "../engine/widgetCatalog";
import type { BridgeStageCoordinator } from "./bridgeStageCoordinator";
import type { LateReplyInboxCoordinator } from "./lateReplyInboxCoordinator";
import {
  processingFlagPath,
  waitModeFlashFlagPath,
} from "./constants";
import { loadBridgeThreadRecordIfExists } from "./threadPersistence";
import { workspaceHash } from "./workspaceHash";

// Wait mode, heartbeat reading, stage helpers, menu surface, and the
// shared workspace utilities all live in dedicated files so this
// module only owns the widget shell + refresh loop. Re-export the
// wait mode setters that index.ts wires at activate time so callers
// outside this folder still have a single import path.
export { applyDefaultWaitMode, parseDefaultWaitMode } from "./waitMode";

import { isAdaptive } from "./waitMode";
import { adaptiveStageCycle } from "./turnHeartbeat";
import {
  currentWorkspacePath,
  isBridgeBusy,
} from "./statusBarState";
import { showMainMenu } from "./statusBarMenus";

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
  events: EventHub,
  bridgeStage: BridgeStageCoordinator,
  lateReplyInbox: LateReplyInboxCoordinator
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
  item.name = "Epic Handshake";
  item.command = COMMAND_ID;
  item.hide();

  // Tooltip is intentionally never assigned. VS Code reshows the
  // hover overlay on every `item.tooltip` reassignment when hovering
  // (Issue #128887, open since 2021) and additionally re-fires the
  // overlay on window focus regain (Issue #293360, fix in PR #305676
  // not yet released). With either mechanism, a tooltip that updates
  // during a turn pops over toasts and reappears every alt-tab,
  // overwhelming the click-menu and toast workflow. All actionable
  // bridge state lives in the click-menu, so the tooltip carries no
  // load-bearing information. The hover falls back to `item.name`
  // ("Epic Handshake"), which is a static label and never reshows.
  // Per-tick dedup on (text, color) still applies to keep idle
  // refresh ticks from re-rendering unchanged status bar cells.
  let lastText: string | undefined;
  let lastColor: vscode.ThemeColor | undefined;

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
  const MAIL_PULSE_DURATION_MS = 3_000;
  const MAIL_VISIBLE_WINDOW_MS = 5 * 60 * 1_000;

  // Subscribe to the engine's response-complete event. Fires once per
  // completed Claude turn. We only increment the pulse counter when
  // mail is actually pending - the subscription is cheap enough to
  // stay live for the lifetime of the widget.
  const responseSub = events.on("session.responseComplete", (p) => {
    if (p.provider !== "claude") return;
    const ws = currentWorkspacePath();
    if (!ws) return;
    const pending = lateReplyInbox.snapshot().pendingCount;
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

  // Delivered-flash tracking. The flash kicks in on the
  // walker-active -> walker-inactive transition (walker finished
  // walking through stages 1-5 + post-walk hold). NOT on lastSuccessAt
  // alone - that fires the moment the dispatcher marks success, which
  // is mid-walk on fast turns and would leak the check icon while
  // stage 4 / 5 were still rendering. Flash holds for 2000ms and
  // requires a recent success record so it never fires after a
  // cancel / error walk-down. */
  let deliveredShownAt: number | null = null;
  let prevWalkerActive = false;
  const DELIVERED_HOLD_MS = 2000;
  /** lastSuccessAt freshness window for arming the flash. The flash
   * only triggers when the walker just ended AND the dispatcher
   * reported a successful delivery within this window. Wider than
   * the hold itself so a slow walker (long turn) still arms the
   * flash when it eventually settles. */
  const DELIVERED_SUCCESS_WINDOW_MS = 60_000;

  // Sending-phase start tracker. Enforces a 3000ms floor on the
  // arrow-circle-right animation before the processing (comment-
  // discussion) animation can take over, so brief prompts never
  // skip the "sending" visual cue entirely.
  let sendingStartedAt: number | null = null;
  const SENDING_MIN_MS = 3_000;

  function refresh(opts: { enabled: boolean; workspacePath: string | null }): void {
    if (!opts.enabled) {
      item.hide();
      deliveredShownAt = null;
      return;
    }

    // Engine-owned bridge state. Snapshot is recomputed by the
    // coordinator on its 1s polling timer and on every fs-watch event
    // (heartbeat write, flag flip, envelope arrival), so this read is
    // always current within ~50ms of the underlying state change.
    const snapshot = bridgeStage.snapshot();
    const wsHash = opts.workspacePath ? workspaceHash(opts.workspacePath) : null;
    const rec = opts.workspacePath ? loadBridgeThreadRecordIfExists(opts.workspacePath) : null;
    const paused = snapshot.paused;
    const fails = rec?.consecutiveFailures ?? 0;
    const inFlight = isBridgeBusy(opts.workspacePath);
    const processing = wsHash ? existsSync(processingFlagPath(wsHash)) : false;
    const returning = snapshot.returning;

    // Track sending-phase start so we can enforce a 3s floor. Sending
    // means in-flight but processing hasn't begun yet. When the turn
    // ends (returning or idle) reset the tracker.
    const sendingActive = inFlight && !processing && !returning;
    if (sendingActive && sendingStartedAt === null) {
      sendingStartedAt = Date.now();
    } else if (!inFlight && !processing) {
      sendingStartedAt = null;
    }
    const inboxSnapshot = lateReplyInbox.snapshot();
    const pendingCount = opts.workspacePath ? inboxSnapshot.pendingCount : 0;
    if (pendingCount === 0 && mailArrivedAt !== null) {
      // Inbox cleared (consumed by a prompt or retrieved manually).
      // Reset pulse state so the next arrival starts with pulse 1.
      mailArrivedAt = null;
      mailPulseCount = 0;
      mailPulseStartedAt = null;
    }
    const now = Date.now();
    const lastSuccessMs = rec?.lastSuccessAt ? new Date(rec.lastSuccessAt).getTime() : 0;

    // State priority: paused > bridge-error > in-flight > delivered
    // flash > late-reply > error-sticky > idle. Animation frames use
    // wall-clock parity so no extra timer is needed.
    const oneHz = Math.floor(now / 1000) % 2 === 0;

    let icon: string;

    // Honor the 3s sending floor: if processing just kicked in but
    // we have not displayed sending long enough, keep rendering the
    // arrow-circle-right animation so a fast reply does not skip it.
    const sendingElapsed = sendingStartedAt !== null ? now - sendingStartedAt : Infinity;
    const showSendingOverride = processing && sendingElapsed < SENDING_MIN_MS;

    // Adaptive mode: the engine's bridge stage coordinator owns the
    // walker, the latch, and the synthetic post-heartbeat-cleanup
    // continuation. Standard and Fire-and-Forget modes skip the
    // numbered-stage override so existing visuals stay unchanged.
    const adaptive = isAdaptive();
    const walkerActive = adaptive && snapshot.latchedStage !== null;

    // Walker-end transition: arms the delivered-flash on the falling
    // edge of walkerActive. Requires a recent successful delivery on
    // the bridge thread record so a cancel / bridge-error walk-down
    // never produces a spurious check icon. Driven off lastSuccessMs
    // freshness window rather than per-tick polling so the flash
    // survives the natural ~1s between snapshot ticks.
    if (
      prevWalkerActive &&
      !walkerActive &&
      lastSuccessMs > 0 &&
      now - lastSuccessMs < DELIVERED_SUCCESS_WINDOW_MS
    ) {
      deliveredShownAt = now;
    }
    prevWalkerActive = walkerActive;
    const justDelivered =
      deliveredShownAt !== null && now - deliveredShownAt < DELIVERED_HOLD_MS;
    if (!justDelivered) deliveredShownAt = null;

    if (paused) {
      icon = "$(wat321-square-pause)";
    } else if (walkerActive && snapshot.latchedStage !== null) {
      // Walker drives the glyph from the engine-owned latched stage.
      // Coordinator handles min-hold, max-hold, force-advance, and
      // post-heartbeat-cleanup continuation. When the walker reaches
      // stage 5 and its 3s hold expires, snapshot.latchedStage flips
      // to null and this branch goes inactive - the widget falls into
      // the returning / idle branches for the handoff animation.
      icon = adaptiveStageCycle(snapshot.latchedStage, oneHz, returning);
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
      icon = useStageGlyph
        ? adaptiveStageCycle(snapshot.latchedStage ?? "dispatched", oneHz, returning)
        : oneHz
          ? "$(wat321-square-arrow-right)"
          : "$(wat321-square)";
    } else if (processing) {
      // Pulse info icon on/off at 1Hz against the empty square to keep
      // the status bar cell width constant (no layout shift). Adaptive
      // mode overrides with the numbered stage glyph; if somehow no
      // heartbeat landed yet, fall back to stage=dispatched so the
      // widget stays on the glyph track rather than switching frames.
      const useStageGlyph = adaptive;
      icon = useStageGlyph
        ? adaptiveStageCycle(snapshot.latchedStage ?? "dispatched", oneHz, returning)
        : oneHz
          ? "$(wat321-square-info)"
          : "$(wat321-square)";
    } else if (justDelivered) {
      // Solid check held for DELIVERED_HOLD_MS (2000ms). Walker has
      // already finished its full 1-5 walk + post-walk hold by the
      // time this branch runs (priority chain above gates on
      // walkerActive). The check means "the entire turn including
      // its visual handoff is done." Takes precedence over the
      // returning flag so a fast turn does not show arrow-left
      // briefly between walker-end and delivered-flash arming.
      icon = "$(wat321-square-check)";
    } else if (returning) {
      // Post-turn latch: the dispatcher holds this flag for 5000ms so
      // the return animation is visible if the walker did not already
      // cover stage 5's arrow-left cycle (e.g., adaptive disabled).
      // In adaptive mode the walker always reaches stage 5 with its
      // own arrow-left cycle, so this branch is mostly a fallback.
      icon = oneHz ? "$(wat321-square-arrow-left)" : "$(wat321-square)";
    } else if (renderWaitModeFlash(now, wsHash)) {
      // User-initiated wait-mode toggle needs visible feedback, so
      // the flash preempts pendingCount / fail-count states that
      // would otherwise mask it. Held solid (no alternation) for the
      // 2500ms window: the tier refresh runs at 1000ms and any sub-
      // tick alternation lands on the same parity at every sample,
      // producing a static frame anyway. Falls through to whichever
      // state was preempted on the next tick after expiry (the flag-
      // file unlink happens lazily inside renderWaitModeFlash).
      icon = "$(wat321-square-bolt)";
    } else if (pendingCount > 0) {
      // Track arrival time of the current mail generation. A newer
      // mtime means a fresh envelope landed - reset the pulse state
      // so the user sees the initial pulse + 3 follow-up pulses on
      // the new mail rather than the stale counter from whatever
      // cleared just before.
      const newestAgeMs = inboxSnapshot.newestAgeMs;
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
      } else {
        icon = inPulseWindow && oneHz ? "$(mail-read)" : "$(mail)";
      }
    } else if (fails > 0) {
      icon = "$(wat321-square-alert)";
    } else {
      icon = "$(wat321-epic-handshake)";
    }

    // Per-tick dedup on (text, color). Tooltip is intentionally never
    // assigned (see constructor comment).
    if (icon !== lastText) {
      item.text = icon;
      lastText = icon;
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

