import { basename } from "node:path";
import type * as vscode from "vscode";
import type { ProviderKey } from "./contracts";
import type { EventHub } from "./eventHub";
import {
  logNotifEvent,
  sessionIdFromPath,
  type BridgeDecisionReason,
} from "../shared/diag/notifEventLog";

/**
 * Generic bridge that watches a session-token service for contextUsed
 * growth and emits `session.responseComplete`. Dependencies injected
 * so engine stays free of tool-tier reach and each provider supplies
 * its own parser, classifier, and tail reader. See `WAT321_MEMORY_EXTENDED.md`
 * for the dual-trigger rationale and the freshness-gating details.
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

/** A workspace session's done-transition surfaced by the service for
 * the bridge to fire `session.responseComplete` against - covers
 * sessions other than the ranker-picked active one. */
export interface NonActiveCompletion {
  sessionId: string;
  transcriptPath: string;
  label: string;
  sessionTitle: string;
  completedAtMs: number;
}

export interface SessionResponseBridgeConfig {
  provider: ProviderKey;
  displayName: string;
  tokenService: {
    subscribe: (listener: (state: MaybeOkState) => void) => void;
    unsubscribe: (listener: (state: MaybeOkState) => void) => void;
    getActiveTranscriptPath: () => string | null;
    /** Drain non-active session completions since the last call.
     * Optional - providers without multi-session detection omit it. */
    consumeNonActiveCompletions?: () => NonActiveCompletion[];
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
  // Path switch resets the baseline so a contextUsed comparison
  // across rollouts cannot fire a phantom responseComplete; the
  // path-switch completion trigger handles the "turn finished during
  // a session switch" case explicitly.
  let prevTranscriptPath: string | null = null;
  // Per-process record of transcript paths the bridge has seen.
  // Bounds the path-switch completion trigger to first-encounter so
  // flipping back to a previously-seen path cannot re-fire its old
  // completion. Cleared only on process exit.
  const seenPaths = new Set<string>();
  // Start true so a cached "done" state replay on startup does not
  // register as a fresh not-done -> done transition on the very
  // first emission. The first-read guard below stops that case
  // anyway but this keeps the tracking stable.
  let prevClassifierDone = true;

  const listener = (state: MaybeOkState) => {
    if (state.status !== "ok") return;
    const session = (state as { status: "ok"; session: SessionResponseFields }).session;
    const now = Date.now();

    const path = cfg.tokenService.getActiveTranscriptPath();
    const isPathSwitch = path !== prevTranscriptPath;
    const isNewPath = path !== null && !seenPaths.has(path);
    if (isPathSwitch) {
      prevTranscriptPath = path;
      prevContextUsed = -1;
      prevClassifierDone = true;
    }
    if (path !== null) seenPaths.add(path);

    const isFirstRead = prevContextUsed === -1;
    const contextChanged = session.contextUsed !== prevContextUsed;
    const isIncrease = session.contextUsed > prevContextUsed;

    // Freshness gate: only fire when the transcript was written
    // within the recent-activity window. A real turn completion
    // writes seconds ago, while a session-switch artifact or
    // cached state replay points at a transcript written minutes
    // to hours ago.
    const mtimeFresh =
      now - session.lastActiveAt <= RECENT_ACTIVITY_WINDOW_MS;

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

    // Path-switch completion trigger: the path changed to one the
    // bridge has never seen, the new tail is already done, and it
    // was written within the freshness window. This is the "turn
    // finished during a session switch" case - VS Code reopen plus
    // a short prompt into a different session can land the full
    // completion before our widget noticed the path moved, and the
    // path-switch + first-read guards would otherwise swallow the
    // notification entirely. Bounded to first-encounter so flipping
    // between two known sessions does not re-fire either's old
    // completion. mtimeFresh + classifierDone keep stale replays
    // (yesterday's done transcripts) from triggering.
    const pathSwitchCompletionTrigger =
      isPathSwitch &&
      isNewPath &&
      mtimeFresh &&
      classifierDone &&
      tail !== null;
    // Trigger 1: contextUsed actually increased AND classifier says
    // done. The common case on a normal pace of turns.
    const contextIncreaseTrigger = contextChanged && isIncrease && classifierDone;
    // Trigger 2: classifier just transitioned from not-done to done
    // without a visible contextUsed increase on this emission.
    // Catches the fast-reply race where a prior emission already
    // consumed the token_count bump while classified mid-turn.
    const doneTransitionTrigger = !wasDone && classifierDone;

    let reason: BridgeDecisionReason;
    if (pathSwitchCompletionTrigger) {
      reason = "fire-path-switch-completion";
    } else if (isFirstRead) {
      reason = "suppress-first-read";
    } else if (!mtimeFresh) {
      reason = "suppress-mtime-stale";
    } else if (contextIncreaseTrigger) {
      reason = "fire-context-increase";
    } else if (doneTransitionTrigger) {
      reason = "fire-done-transition";
    } else {
      reason = "suppress-no-trigger";
    }
    const willFire = reason.startsWith("fire-");

    // Disk-tee every decision so a post-mortem can reconstruct
    // exactly which gate caught the emission. The single most
    // useful signal when "the notification did not fire" - tells
    // you whether the chain even reached the toast notifier or got
    // swallowed here.
    logNotifEvent({
      at: now,
      kind: "bridge-decision",
      provider: cfg.provider,
      path,
      sessionId: sessionIdFromPath(cfg.provider, path),
      decision: willFire ? "fire" : "suppress",
      reason,
      contextChanged,
      isIncrease,
      classifierDone,
      mtimeFresh,
      isPathSwitch,
      isNewPath,
    });

    // Drain non-active completions every emission, regardless of the
    // active-session decision. A suppress on the active path must not
    // strand a queued non-active completion behind the gate.
    drainNonActiveCompletions(cfg);

    if (!willFire) return;

    const responsePreview = cfg.shouldParsePreview() && tail
      ? cfg.parseAssistantText(tail)
      : "";

    // Derive a stable per-session id from the transcript path's
    // basename. Both providers shape it the same way: Claude is
    // `<uuid>.jsonl`, Codex is `rollout-<uuid>.jsonl`. The full
    // path would also work but is longer - basename is enough to
    // scope the cross-window dedup tag without collisions across
    // sessions.
    const sessionId = path !== null ? basename(path) : "no-path";

    cfg.events.emit("session.responseComplete", {
      provider: cfg.provider,
      displayName: cfg.displayName,
      label: session.label,
      sessionTitle: session.sessionTitle,
      responsePreview,
      sessionId,
      completionMs: now,
    });
  };

  cfg.tokenService.subscribe(listener);
  return { dispose: () => cfg.tokenService.unsubscribe(listener) };
}

function drainNonActiveCompletions(cfg: SessionResponseBridgeConfig): void {
  const drain = cfg.tokenService.consumeNonActiveCompletions;
  if (!drain) return;
  const completions = drain();
  if (completions.length === 0) return;
  for (const completion of completions) {
    const tail = cfg.readTail(completion.transcriptPath);
    const preview =
      cfg.shouldParsePreview() && tail ? cfg.parseAssistantText(tail) : "";
    cfg.events.emit("session.responseComplete", {
      provider: cfg.provider,
      displayName: cfg.displayName,
      label: completion.label,
      sessionTitle: completion.sessionTitle,
      responsePreview: preview,
      sessionId: completion.sessionId,
      completionMs: completion.completedAtMs,
    });
    logNotifEvent({
      at: completion.completedAtMs,
      kind: "bridge-decision",
      provider: cfg.provider,
      path: completion.transcriptPath,
      sessionId: completion.sessionId,
      decision: "fire",
      reason: "fire-non-active-completion",
      contextChanged: false,
      isIncrease: false,
      classifierDone: true,
      mtimeFresh: true,
      isPathSwitch: false,
      isNewPath: false,
    });
  }
}
