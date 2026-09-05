import { existsSync } from "node:fs";
import * as vscode from "vscode";
import { workspaceHash } from "../../engine/workspaceHash";
import type { BridgeStageCoordinator } from "../bridgeStage/bridgeStageCoordinator";
import { MailPulse } from "./epicHandshakeMailPulse";
import { processingFlagPath } from "../epicHandshakePaths";
import {
  isWaitModeFlashActive,
  readOpenCodeHeartbeatActivity,
  syntheticOpenCodeStage,
} from "./epicHandshakeStatusBarSources";
import type { InboxCoordinator } from "../../engine/inbox/inboxCoordinator";
import { currentWorkspacePath, isBridgeBusy } from "./statusBarState";
import { loadBridgeThreadRecordIfExists } from "../codexTurn/threadRecord";
import { adaptiveStageCycle } from "../bridgeStage/turnHeartbeat";
import { isAdaptive } from "../codexTurn/waitMode";

/**
 * Refresh logic for the Epic Handshake status-bar widget. Called by
 * the factory's outer `refresh(opts)` shim every tier tick (1Hz) and
 * also opportunistically by the engine when bridge state changes
 * out-of-band.
 *
 * State priority (first match wins):
 *   paused -> bridge-error sticky -> in-flight -> delivered flash ->
 *   late-reply (mail) -> error -> idle.
 *
 * Animation frames use wall-clock parity (`Math.floor(now/1000) % 2`)
 * so no dedicated animation timer is needed - the 1000ms refresh
 * cadence drives every transition.
 *
 * Mutable state moves through `RefreshContext.state` rather than
 * closure capture so the function is callable from any caller
 * holding the context.
 */

const DELIVERED_HOLD_MS = 2000;
/** lastSuccessAt freshness window for arming the delivered flash.
 * The flash only triggers when the walker just ended AND the
 * dispatcher reported a successful delivery within this window.
 * Wider than the hold itself so a slow walker (long turn) still
 * arms the flash when it eventually settles. */
const DELIVERED_SUCCESS_WINDOW_MS = 60_000;
/** 3000ms floor on the arrow-circle-right animation before the
 * processing (comment-discussion) animation can take over, so brief
 * prompts never skip the "sending" visual cue entirely. */
const SENDING_MIN_MS = 3_000;

interface RefreshState {
  mail: MailPulse;
  deliveredShownAt: number | null;
  prevWalkerActive: boolean;
  sendingStartedAt: number | null;
  lastText: string | undefined;
}

export function createInitialRefreshState(): RefreshState {
  return {
    mail: new MailPulse(),
    deliveredShownAt: null,
    prevWalkerActive: false,
    sendingStartedAt: null,
    lastText: undefined,
  };
}

export interface RefreshContext {
  item: vscode.StatusBarItem;
  bridgeStage: BridgeStageCoordinator;
  lateReplyInbox: InboxCoordinator;
  state: RefreshState;
}

/** Mail-pulse subscription handler. Invoked on every Claude
 * `session.responseComplete` so the widget reminds the user of a
 * pending bridge reply each time they finish a Claude turn. */
export function onClaudeResponseComplete(
  state: RefreshState,
  lateReplyInbox: InboxCoordinator
): void {
  if (currentWorkspacePath() === null) return;
  if (lateReplyInbox.snapshot().pendingCount === 0) return;
  state.mail.onClaudeResponseComplete(Date.now());
}

export function refreshEpicHandshakeItem(
  ctx: RefreshContext,
  opts: { enabled: boolean; workspacePath: string | null }
): void {
  const { item, bridgeStage, lateReplyInbox, state } = ctx;

  if (!opts.enabled) {
    item.hide();
    state.deliveredShownAt = null;
    return;
  }

  // Engine-owned bridge snapshot. Recomputed by the coordinator on
  // its 1s polling timer and on every fs-watch event (heartbeat,
  // flag flip, envelope arrival) so this read is always current
  // within ~50ms of the underlying state change.
  const snapshot = bridgeStage.snapshot();
  const wsHash = opts.workspacePath ? workspaceHash(opts.workspacePath) : null;
  const rec = opts.workspacePath
    ? loadBridgeThreadRecordIfExists(opts.workspacePath)
    : null;
  const paused = snapshot.paused;
  const fails = rec?.consecutiveFailures ?? 0;
  const inFlight = isBridgeBusy(opts.workspacePath);
  const processing = wsHash ? existsSync(processingFlagPath(wsHash)) : false;
  const returning = snapshot.returning;

  // Track sending-phase start so we can enforce a 3s floor. Sending
  // means in-flight but processing has not begun yet. Reset on turn
  // end (returning or idle).
  const sendingActive = inFlight && !processing && !returning;
  if (sendingActive && state.sendingStartedAt === null) {
    state.sendingStartedAt = Date.now();
  } else if (!inFlight && !processing) {
    state.sendingStartedAt = null;
  }

  const inboxSnapshot = lateReplyInbox.snapshot();
  const pendingCount = opts.workspacePath ? inboxSnapshot.pendingCount : 0;
  if (pendingCount === 0) state.mail.reset();
  const now = Date.now();
  const lastSuccessMs = rec?.lastSuccessAt
    ? new Date(rec.lastSuccessAt).getTime()
    : 0;

  const oneHz = Math.floor(now / 1000) % 2 === 0;

  // Honor the 3s sending floor: if processing just kicked in but we
  // have not displayed sending long enough, keep rendering the
  // arrow-circle-right animation so a fast reply does not skip it.
  const sendingElapsed =
    state.sendingStartedAt !== null ? now - state.sendingStartedAt : Infinity;
  const showSendingOverride = processing && sendingElapsed < SENDING_MIN_MS;

  // Adaptive mode: the engine's bridge stage coordinator owns the
  // walker, the latch, and the synthetic post-heartbeat-cleanup
  // continuation. Standard and Fire-and-Forget skip the numbered-
  // stage override so existing visuals stay unchanged.
  const adaptive = opts.workspacePath ? isAdaptive(opts.workspacePath) : false;
  const walkerActive = adaptive && snapshot.latchedStage !== null;

  // Walker-end transition arms the delivered-flash on the falling
  // edge of walkerActive. Requires a recent successful delivery on
  // the bridge thread record so a cancel / bridge-error walk-down
  // never produces a spurious check icon.
  if (
    state.prevWalkerActive &&
    !walkerActive &&
    lastSuccessMs > 0 &&
    now - lastSuccessMs < DELIVERED_SUCCESS_WINDOW_MS
  ) {
    state.deliveredShownAt = now;
  }
  state.prevWalkerActive = walkerActive;
  const justDelivered =
    state.deliveredShownAt !== null &&
    now - state.deliveredShownAt < DELIVERED_HOLD_MS;
  if (!justDelivered) state.deliveredShownAt = null;

  let icon: string;

  if (paused) {
    icon = "$(wat321-square-pause)";
  } else if (walkerActive && snapshot.latchedStage !== null) {
    // Walker drives the glyph from the engine-owned latched stage.
    // When the walker reaches stage 5 and its 3s hold expires,
    // snapshot.latchedStage flips to null and the branch goes
    // inactive - the widget falls into returning / idle branches
    // for the handoff animation.
    icon = adaptiveStageCycle(snapshot.latchedStage, oneHz, returning);
  } else if (!returning && (sendingActive || showSendingOverride)) {
    // Adaptive heartbeat takes precedence over the classic arrow
    // animation once the dispatcher has stage info to share. Fall
    // back to stage=dispatched glyph when adaptive is on but no
    // heartbeat file exists yet (envelope read, client spawn,
    // thread/start RPC can be 5-10s on cold start). Without this
    // fallback the status bar would render the arrow animation and
    // the user would miss stage 1 entirely.
    icon = adaptive
      ? adaptiveStageCycle(
          snapshot.latchedStage ?? "dispatched",
          oneHz,
          returning
        )
      : oneHz
        ? "$(wat321-square-arrow-right)"
        : "$(wat321-square)";
  } else if (processing) {
    // Pulse info icon on/off at 1Hz against the empty square to
    // keep the status bar cell width constant. Adaptive overrides
    // with the numbered stage glyph - if no heartbeat landed yet,
    // fall back to stage=dispatched so the widget stays on the
    // glyph track rather than switching frames.
    icon = adaptive
      ? adaptiveStageCycle(
          snapshot.latchedStage ?? "dispatched",
          oneHz,
          returning
        )
      : oneHz
        ? "$(wat321-square-info)"
        : "$(wat321-square)";
  } else if (justDelivered) {
    // Solid check held for DELIVERED_HOLD_MS. Walker has already
    // finished its full 1-5 walk + post-walk hold. Takes
    // precedence over `returning` so a fast turn does not show
    // arrow-left briefly between walker-end and delivered-flash.
    icon = "$(wat321-square-check)";
  } else if (returning) {
    // Post-turn latch: the dispatcher holds this flag for 5000ms
    // so the return animation is visible if the walker did not
    // already cover stage 5's arrow-left cycle. In adaptive mode
    // the walker always reaches stage 5 with its own arrow-left
    // cycle so this branch is mostly a fallback.
    icon = oneHz ? "$(wat321-square-arrow-left)" : "$(wat321-square)";
  } else if (readOpenCodeHeartbeatActivity(wsHash) !== null) {
    // OC/Local dispatch in flight (and no Codex turn active - the
    // earlier branches would have caught that). Drives the same
    // adaptive cycle the Codex flow uses, with the stage
    // synthesized from elapsed time. Standard / fire-and-forget
    // fall back to the classic outbound arrow cycle.
    const mb = readOpenCodeHeartbeatActivity(wsHash);
    const elapsedMs = mb !== null ? Math.max(0, now - mb.startedAtMs) : 0;
    icon = adaptive
      ? adaptiveStageCycle(syntheticOpenCodeStage(elapsedMs), oneHz, false)
      : oneHz
        ? "$(wat321-square-arrow-right)"
        : "$(wat321-square)";
  } else if (isWaitModeFlashActive(now, wsHash)) {
    // User-initiated wait-mode toggle needs visible feedback, so
    // the flash preempts pendingCount / fail-count states. Held
    // solid (no alternation) for the 2500ms window since the 1Hz
    // refresh cadence would land on the same parity at every
    // sample. Falls through to whichever state was preempted on
    // the next tick (the flag-file unlink happens lazily inside
    // isWaitModeFlashActive).
    icon = "$(wat321-square-bolt)";
  } else if (pendingCount > 0) {
    icon = state.mail.glyph(now, inboxSnapshot.newestAgeMs, oneHz);
  } else if (fails > 0) {
    icon = "$(wat321-square-alert)";
  } else {
    icon = "$(wat321-epic-handshake)";
  }

  // Per-tick dedup on text. Tooltip is intentionally never assigned
  // (see factory comment).
  if (icon !== state.lastText) {
    item.text = icon;
    state.lastText = icon;
  }
  item.show();
}
