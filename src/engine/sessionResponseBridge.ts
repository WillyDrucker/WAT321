import type * as vscode from "vscode";
import type { ProviderKey } from "./contracts";
import type { EventHub } from "./eventHub";

/**
 * Generic bridge that watches a session token service for contextUsed
 * growth and emits `session.responseComplete` on the EventHub.
 *
 * Two independent triggers can cause a notification to fire, whichever
 * happens first per turn:
 *   1. `contextUsed` increase + classifier says done. Handles the
 *      common case where the service's state-change emission carries
 *      both signals at once.
 *   2. Classifier transitions `not-done` -> `done`. Catches a race on
 *      fast Codex replies where multiple events (`user_message`,
 *      `token_count`, `agent_message`, `task_complete`) land in a
 *      single watcher-debounce window. Without the transition
 *      trigger, the first emission sees `contextUsed` jump with the
 *      tail ending on `user_message` and is classified mid-turn;
 *      the second emission sees the tail ending on `agent_message`
 *      but `contextUsed` no longer changed, so neither emission
 *      would fire. The transition check does.
 *
 * Gating lives here so services stay notification-unaware:
 *   - Skip the initial subscription replay (first emission is state,
 *     not an event).
 *   - Skip contextUsed decreases (auto-compact summaries can drop
 *     token count; that is not a new response).
 *   - Skip stale-transcript emissions where the last write was more
 *     than `RECENT_ACTIVITY_WINDOW_MS` ago. This catches two session-
 *     switch artifacts: clicking into an older session whose tail
 *     still shows a completed assistant turn would otherwise fire a
 *     fresh toast for an hours-old message, and service-discovery
 *     replays that reach us from cached state would fire a toast
 *     the moment the extension activates.
 *   - Skip preview parsing when notifications are disabled upstream
 *     (`shouldParsePreview`). The tail is still read when a classifier
 *     is provided, since the classifier needs it - only the assistant-
 *     text parse is gated.
 *
 * Dependencies are injected so this module lives cleanly in engine
 * without reaching into shared/. Tool independence preserved - each
 * provider supplies its own parser, classifier, and tail reader.
 */

/** Transcript writes older than this are treated as state replay /
 * stale session switch artifacts and do not fire a notification.
 * A real turn completion writes to the transcript within seconds;
 * 30 seconds gives headroom for slow systems without letting stale
 * activations through. */
const RECENT_ACTIVITY_WINDOW_MS = 30_000;

interface SessionResponseFields {
  contextUsed: number;
  label: string;
  sessionTitle: string;
  /** Transcript file mtime in ms. Used to distinguish real in-
   * progress turns from replays and session-switch artifacts. */
  lastActiveAt: number;
}

type MaybeOkState = { status: "ok"; session: SessionResponseFields } | { status: string };

export interface SessionResponseBridgeConfig {
  provider: ProviderKey;
  displayName: string;
  tokenService: {
    subscribe: (listener: (state: MaybeOkState) => void) => void;
    unsubscribe: (listener: (state: MaybeOkState) => void) => void;
    getActiveTranscriptPath: () => string | null;
  };
  readTail: (path: string) => string | null;
  parseAssistantText: (tail: string) => string;
  /** Returns true when the tail represents a completed assistant
   * turn. Null biases toward firing on every increase. */
  isTurnComplete: ((tail: string) => boolean) | null;
  /** Returns true when a preview should be parsed (i.e. notifications
   * are enabled). Skipping the parse saves a full tail read. */
  shouldParsePreview: () => boolean;
  events: EventHub;
}

export function bridgeSessionResponse(
  cfg: SessionResponseBridgeConfig
): vscode.Disposable {
  let prevContextUsed = -1;
  // Start true so a cached "done" state replay on startup does not
  // register as a fresh not-done -> done transition on the very
  // first emission. The first-read guard below stops that case
  // anyway but this keeps the tracking stable.
  let prevClassifierDone = true;

  const listener = (state: MaybeOkState) => {
    if (state.status !== "ok") return;
    const session = (state as { status: "ok"; session: SessionResponseFields }).session;

    const isFirstRead = prevContextUsed === -1;
    const contextChanged = session.contextUsed !== prevContextUsed;
    const isIncrease = session.contextUsed > prevContextUsed;

    // Freshness gate: only fire when the transcript was written
    // within the recent-activity window. A real turn completion
    // writes seconds ago; a session-switch artifact or cached state
    // replay points at a transcript written minutes to hours ago.
    const mtimeFresh =
      Date.now() - session.lastActiveAt <= RECENT_ACTIVITY_WINDOW_MS;

    const path = cfg.tokenService.getActiveTranscriptPath();
    const tail = path ? cfg.readTail(path) : null;
    // Default true when no classifier is provided so the original
    // contextUsed-increase behavior stays the fallback.
    const classifierDone = cfg.isTurnComplete && tail
      ? cfg.isTurnComplete(tail)
      : true;

    const wasDone = prevClassifierDone;

    // Advance tracking before the early-return gates so subsequent
    // emissions see a consistent baseline even when we skip.
    if (contextChanged) prevContextUsed = session.contextUsed;
    prevClassifierDone = classifierDone;

    if (isFirstRead) return;
    if (!mtimeFresh) return;

    // Trigger 1: contextUsed actually increased AND classifier says
    // done. The common case on a normal pace of turns.
    const contextIncreaseTrigger = contextChanged && isIncrease && classifierDone;
    // Trigger 2: classifier just transitioned from not-done to done
    // without a visible contextUsed increase on this emission.
    // Catches the fast-reply race where a prior emission already
    // consumed the token_count bump while classified mid-turn.
    const doneTransitionTrigger = !wasDone && classifierDone;

    if (!contextIncreaseTrigger && !doneTransitionTrigger) return;

    const responsePreview = cfg.shouldParsePreview() && tail
      ? cfg.parseAssistantText(tail)
      : "";

    cfg.events.emit("session.responseComplete", {
      provider: cfg.provider,
      displayName: cfg.displayName,
      label: session.label,
      sessionTitle: session.sessionTitle,
      responsePreview,
    });
  };

  cfg.tokenService.subscribe(listener);
  return { dispose: () => cfg.tokenService.unsubscribe(listener) };
}
