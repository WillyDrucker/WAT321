import type { BridgeStageSnapshot } from "../../../engine/bridgeTypes";
import { isPidAlive } from "../../../engine/pidLiveness";
import { isOpenCodeDispatchActive } from "../../bridge/openCodeDispatchHeartbeat";
import type {
  SessionTokenRenderData,
  SessionTokenWidgetDescriptor,
} from "./sessionTokenTypes";

/**
 * Pure prefix selection for the session-token widget: which codicon
 * drives the leading "thinking" cell on every render. Routing order is
 * a Claude wait on OpenCode / Local LLM, then the Epic Handshake bridge
 * branches (ceremony and stage animation), then the native turn
 * indicator. Claude under fire-and-forget skips the bridge branches,
 * and so does Codex when a dispatch targets OpenCode / Local LLM. Stage
 * meanings live in `WAT321_EPIC_HANDSHAKE/bridgeStage/bridgeStageMap.ts`,
 * and all three widgets read one snapshot, so they agree on the stage.
 */

/** No-PID fallback window. The last write is doing both jobs
 * (continuity AND end-of-turn detection) so the window is widened from
 * the descriptor's tight live-PID safety net to ride through normal
 * between-tool deliberation. Classifier transitions still collapse
 * the widget the instant a real end state lands. */
const NO_PID_FALLBACK_MS = 30_000;

/** Activity-window length. Under a PID the descriptor's tight
 * `activeThresholdMs` is just a safety net (PID-alive is the primary
 * continuity signal). With no PID:
 *   - `silentTurnCeilingMs` (when the provider supplies one AND a turn
 *     is in progress) rides a long silent reasoning gap, trusting the
 *     classifier as the real end-of-turn signal. Codex needs this.
 *   - otherwise the `NO_PID_FALLBACK_MS` window applies (idle tail, or
 *     a provider like Claude whose no-PID path is a lastKnown fallback
 *     that must not trust the classifier far enough to widen). */
export function effectiveActiveThresholdMs(
  pid: number | undefined,
  pidThresholdMs: number | undefined,
  silentTurnCeilingMs?: number
): number {
  if (pid !== undefined && pidThresholdMs !== undefined) return pidThresholdMs;
  return silentTurnCeilingMs ?? NO_PID_FALLBACK_MS;
}

/** True when an in-flight turn's transcript is fresh enough to keep
 * the active indicator alive. The single home for the in-turn
 * freshness predicate, shared by `pickPrefix` (native branch) and the
 * widget's ticker keep-alive so the two cannot drift. Applies the
 * provider's `silentTurnCeilingMs` (Codex rides a long silent
 * reasoning gap), and falls back to the no-PID window otherwise. The idle-
 * tail freshness check (no turn in progress) deliberately stays a
 * direct `effectiveActiveThresholdMs` call - it omits the ceiling so
 * an idle widget suspends its ticker quickly. */
export function isTurnFresh<TState extends { status: string }>(
  data: SessionTokenRenderData,
  descriptor: SessionTokenWidgetDescriptor<TState>,
  now: number
): boolean {
  return (
    now - data.lastWriteMs <
    effectiveActiveThresholdMs(
      data.pid,
      descriptor.activeThresholdMs,
      descriptor.silentTurnCeilingMs
    )
  );
}

interface PickPrefixArgs<TState extends { status: string }> {
  descriptor: SessionTokenWidgetDescriptor<TState>;
  data: SessionTokenRenderData;
  snapshot: BridgeStageSnapshot;
  now: number;
}

export function pickPrefix<TState extends { status: string }>(
  args: PickPrefixArgs<TState>
): string {
  const { descriptor: d, data, snapshot, now } = args;

  // Fire-and-Forget returns Claude's MCP call immediately, so the
  // Claude widget bypasses every bridge-driven branch and renders
  // from its own transcript activity. Codex still walks ceremony /
  // stage 1 fallback under FaF because Codex is doing the work.
  const claudeBypassesBridge =
    d.provider === "Claude" && snapshot.waitMode === "fire-and-forget";

  // Claude-to-OpenCode / Local LLM dispatches don't flow through the
  // EH bridge stage coordinator. The dispatch handler writes a
  // heartbeat under the OpenCode Routes state dir. While fresh,
  // Claude's MCP call is blocked on the OpenCode reply.
  if (
    d.provider === "Claude" &&
    isOpenCodeDispatchActive() &&
    snapshot.phase === "idle"
  ) {
    const tick = Math.floor(now / 1000) % 2;
    return tick === 0 ? "$(blank)" : "$(claude)";
  }

  // Codex widget suppresses every bridge-driven animation when the
  // active dispatch targets OpenCode / Local LLM - the Codex side is
  // idle for the whole of such a dispatch.
  const heartbeatTarget = snapshot.heartbeat?.target;
  const codexOffTarget =
    d.provider === "Codex" &&
    heartbeatTarget !== undefined &&
    heartbeatTarget !== "codex";

  if (snapshot.phase !== "idle" && !claudeBypassesBridge && !codexOffTarget) {
    if (snapshot.phase === "pre-ceremony") {
      const tick = Math.floor(now / 1000) % 2;
      return tick === 0 ? "$(blank)" : d.idlePrefix;
    }
    if (snapshot.ceremonyActive) {
      const elapsed = now - (snapshot.heartbeat?.turnStartedAt ?? now);
      if (d.provider === "Claude") {
        // Claude is the side that just dispatched the bridge tool
        // call - native activeFrames reads as "still working" without
        // the debug ceremony's "connecting" flavor. Index by elapsed
        // ceremony time so the frame is deterministic.
        const index = Math.floor(elapsed / d.activeStepMs) % d.activeFrames.length;
        return d.activeFrames[index];
      }
      // Codex side: debug-disconnect / debug-connected ceremony
      // covers the window before codex has acknowledged the bridge
      // turn and started writing its rollout file.
      const frame = Math.floor(elapsed / 1000);
      return frame % 2 === 0 ? "$(debug-disconnect)" : "$(debug-connected)";
    }
    if (d.provider === "Claude") {
      // Adaptive blocks Claude's MCP call on the bridge reply, so
      // render a 1Hz logo blink to mark "Claude is waiting on Codex".
      // FaF was already routed around above.
      const tick = Math.floor(now / 1000) % 2;
      return tick === 0 ? "$(blank)" : "$(claude)";
    }
    // Codex stage 1 (dispatched): rollout file does not exist yet so
    // turnInProgress below would leave the widget on idle. Run the
    // same 1Hz debug-disconnect / connected alternation the ceremony
    // used so the handoff window reads as motion. Stage 2 onward, the
    // rollout is alive and the native activeFrames cycle takes over.
    if (snapshot.latchedStage === "dispatched") {
      const tick = Math.floor(now / 1000) % 2;
      return tick === 0 ? "$(debug-disconnect)" : "$(debug-connected)";
    }
  }

  const turnInProgress =
    data.turnState === "user" || data.turnState === "assistant-pending";
  if (!turnInProgress || d.activeFrames.length === 0) return d.idlePrefix;

  // PID liveness keeps the indicator on through silent thinking and
  // slow tool calls. The last-write backstop is the safety net when
  // the PID is unavailable or dead, on the wider no-PID window where
  // the last write is doing both jobs.
  const pidAlive = data.pid !== undefined && isPidAlive(data.pid);
  if (!pidAlive && !isTurnFresh(data, d, now)) return d.idlePrefix;

  const index = Math.floor(now / d.activeStepMs) % d.activeFrames.length;
  return d.activeFrames[index];
}
