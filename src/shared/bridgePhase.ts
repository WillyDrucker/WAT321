import { isBridgeBusy, isPaused } from "../WAT321_EPIC_HANDSHAKE/statusBarState";
import { readNewestHeartbeat } from "../WAT321_EPIC_HANDSHAKE/turnHeartbeat";
import { currentWaitMode } from "../WAT321_EPIC_HANDSHAKE/waitMode";
import { workspaceHash } from "../WAT321_EPIC_HANDSHAKE/workspaceHash";

/**
 * Shared reader that snapshots Epic Handshake turn state for the
 * session token widgets to render a bridge-aware prefix. Widgets
 * never reach into Epic Handshake directly; they call this function
 * and get back a provider-agnostic snapshot or null.
 *
 * Two phases are distinguished:
 *
 *   "pre-ceremony"  envelope is queued but the dispatcher has not
 *                   yet written the first heartbeat (typically a
 *                   few hundred ms). Widgets render their normal
 *                   thinking frames during this window so the
 *                   transition into the debug ceremony reads as a
 *                   clean handoff - without this, the Claude widget
 *                   can briefly flicker back to idle or the Codex
 *                   widget can show idle while its rollout is
 *                   untouched, both of which are misleading.
 *
 *   "in-turn"       heartbeat landed. Widget owns the frame math
 *                   (4-second ceremony, post-ceremony hold,
 *                   blank/claude blink while Claude is blocking,
 *                   fallthrough to thinking otherwise).
 *
 * Returns null (bridge branch does not fire, widget behaves as if
 * no bridge exists) when any of these is true:
 *   - No workspace open
 *   - Bridge is paused
 *   - Bridge is not busy (no pending / in-flight / processing work)
 *     -> covers success cleanup, error cleanup, and idle state
 *   - Heartbeat stage is `complete`
 *   - Heartbeat exists but is older than 120s (stale; upstream
 *     `readNewestHeartbeat` filters these)
 *
 * Cached for 500ms keyed by workspacePath so the widget's 250ms tick
 * does not stat-spam `~/.wat321/epic-handshake/` during a turn.
 */

export type BridgePhaseSnapshot =
  | { phase: "pre-ceremony" }
  | {
      phase: "in-turn";
      /** Wall-clock ms when the current turn started. Drives the
       * 4-second ceremony from zero, independent of how long any
       * single stage actually lasts. */
      turnStartedAt: number;
      /** Current heartbeat stage. Never `complete` - computePhase
       * short-circuits on complete. */
      stage: "dispatched" | "received" | "working" | "writing";
      /** True when Claude is still blocking on the bridge reply
       * (Standard or Adaptive wait modes). False under
       * Fire-and-Forget where Claude already returned from the tool
       * call. The Claude widget uses this to decide whether to
       * blink its brand glyph or resume normal thinking frames. */
      claudeBlocking: boolean;
    };

interface CacheEntry {
  at: number;
  workspacePath: string | null;
  snapshot: BridgePhaseSnapshot | null;
}

const CACHE_TTL_MS = 500;
let cache: CacheEntry | null = null;

export function readBridgePhase(
  workspacePath: string | null
): BridgePhaseSnapshot | null {
  const now = Date.now();
  if (
    cache !== null &&
    cache.workspacePath === workspacePath &&
    now - cache.at < CACHE_TTL_MS
  ) {
    return cache.snapshot;
  }

  const snapshot = computePhase(workspacePath);
  cache = { at: now, workspacePath, snapshot };
  return snapshot;
}

function computePhase(workspacePath: string | null): BridgePhaseSnapshot | null {
  if (workspacePath === null) return null;
  // Paused or idle bridge -> no animation. Error cleanup also lands
  // here because the dispatcher clears its flags on both success and
  // failure paths, so `isBridgeBusy` flips false as soon as the turn
  // ends for any reason.
  if (isPaused()) return null;
  if (!isBridgeBusy(workspacePath)) return null;

  const hb = readNewestHeartbeat(workspaceHash(workspacePath));
  if (hb === null) {
    // Bridge is busy but the dispatcher has not yet written its
    // first heartbeat. Tell widgets to render thinking frames so
    // the early moments of a bridge turn do not flicker through
    // idle / stale glyphs before the ceremony starts.
    return { phase: "pre-ceremony" };
  }
  if (hb.stage === "complete") return null;

  return {
    phase: "in-turn",
    turnStartedAt: hb.turnStartedAt ?? Date.now(),
    stage: hb.stage,
    claudeBlocking: currentWaitMode() !== "fire-and-forget",
  };
}
