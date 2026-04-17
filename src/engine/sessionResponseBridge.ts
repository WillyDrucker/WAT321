import type * as vscode from "vscode";
import type { ProviderKey } from "./contracts";
import type { EventHub } from "./eventHub";

/**
 * Generic bridge that watches a session token service for contextUsed
 * growth and emits `session.responseComplete` on the EventHub.
 *
 * Gating lives here so services stay notification-unaware:
 *   - Skip the initial subscription replay (first emission is state,
 *     not an event).
 *   - Skip contextUsed decreases (auto-compact summaries can drop
 *     token count; that is not a new response).
 *   - Skip mid-turn emissions when a turn-completion classifier is
 *     provided and returns false.
 *   - Skip preview parsing when notifications are disabled upstream
 *     (`shouldParsePreview`). The tail is still read when a classifier
 *     is provided, since the classifier needs it - only the assistant-
 *     text parse is gated.
 *
 * Dependencies are injected so this module lives cleanly in engine
 * without reaching into shared/. Tool independence preserved - each
 * provider supplies its own parser, classifier, and tail reader.
 */

interface SessionResponseFields {
  contextUsed: number;
  label: string;
  sessionTitle: string;
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

  const listener = (state: MaybeOkState) => {
    if (state.status !== "ok") return;
    const session = (state as { status: "ok"; session: SessionResponseFields }).session;

    if (session.contextUsed === prevContextUsed) return;
    const isFirstRead = prevContextUsed === -1;
    const isIncrease = session.contextUsed > prevContextUsed;
    // Always advance the baseline so post-compact decreases don't
    // strand prevContextUsed at a pre-compact value.
    prevContextUsed = session.contextUsed;
    if (isFirstRead) return;
    if (!isIncrease) return;

    const path = cfg.tokenService.getActiveTranscriptPath();
    const tail = path ? cfg.readTail(path) : null;

    if (cfg.isTurnComplete && tail && !cfg.isTurnComplete(tail)) return;

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
