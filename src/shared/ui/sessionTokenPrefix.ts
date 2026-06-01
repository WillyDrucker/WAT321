import type { BridgeStageSnapshot } from "../../engine/bridgeTypes";
import { isOpenCodeDispatchActive, isPidAlive } from "./sessionTokenHelpers";
import type {
  SessionTokenRenderData,
  SessionTokenWidgetDescriptor,
} from "./sessionTokenTypes";

/**
 * Pure prefix-selection for the session-token widget. Decides which
 * codicon string drives the leading "thinking" cell on every render.
 *
 * Routing order:
 *   1. Claude waiting on OpenCode / Local-LLM (heartbeat fresh, EH
 *      idle) -> 1Hz claude / blank blink. Same shape as EH bridge wait.
 *   2. EH bridge in flight (and not bypassed):
 *      - pre-ceremony: 1Hz logo blink against blank
 *      - ceremony active: provider-specific - Claude uses its native
 *        activeFrames; Codex uses debug-disconnect / debug-connected
 *        alternation
 *      - post-ceremony Claude: 1Hz claude / blank (waiting on Codex)
 *      - post-ceremony Codex stage=dispatched: debug-disconnect /
 *        debug-connected (rollout file not yet present)
 *      - post-ceremony Codex stage>=received: falls through to native
 *   3. Native path: turnState in [user, assistant-pending] AND
 *      (pidAlive OR mtime fresh) -> activeFrames cycle. Otherwise
 *      idlePrefix.
 *
 * Bypasses:
 *   - Claude under wait-mode=fire-and-forget: skips every bridge
 *     branch (MCP call returned immediately, Claude is unblocked).
 *   - Codex when the active dispatch targets OpenCode / Local-LLM:
 *     skips every bridge branch (Codex side is idle during a Big
 *     Pickle FF call).
 *
 * Bridge ceremony / phase / stage definitions live in
 * `WAT321_EPIC_HANDSHAKE/bridgeStageMap.ts`; both session-token
 * widgets and the bridge widget read the same snapshot, so they
 * always observe the same phase + stage at the same instant.
 */

/** Activity-window length. The descriptor's 3s default is tight on
 * purpose - it's a safety net under live PID, where PID-alive is the
 * primary continuity signal. On lastKnown fallback (pid undefined)
 * mtime is doing both jobs (continuity AND end-of-turn detection),
 * so widen to 30s to ride through normal between-tool deliberation.
 * Classifier transitions still collapse the widget the instant a real
 * end state lands. */
export function effectiveActiveThresholdMs(
  pid: number | undefined,
  defaultMs: number
): number {
  if (pid === undefined) return 30_000;
  return defaultMs;
}

export interface PickPrefixArgs<TState extends { status: string }> {
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
  // heartbeat under the OpenCode Routes state dir; while fresh,
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
  // doing nothing during a Big Pickle FF dispatch. Missing target on
  // the heartbeat (legacy / pre-target-plumbing) assumes codex.
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

  // PID liveness keeps the indicator on through silent thinking
  // (deep Opus reasoning, slow tool calls). Mtime backstop is the
  // safety net when PID is unavailable or dead; threshold widens to
  // 30s on lastKnown fallback where mtime is doing both jobs.
  const pidAlive = data.pid !== undefined && isPidAlive(data.pid);
  const mtimeFresh =
    now - data.transcriptMtimeMs < effectiveActiveThresholdMs(data.pid, d.activeThresholdMs);
  if (!pidAlive && !mtimeFresh) return d.idlePrefix;

  const index = Math.floor(now / d.activeStepMs) % d.activeFrames.length;
  return d.activeFrames[index];
}
