import { isPidAlive } from "./sessionTokenHelpers";
import type {
  SessionTokenRenderData,
  SessionTokenWidgetDescriptor,
} from "./sessionTokenTypes";

/**
 * Pure prefix-selection for the session-token widget. Decides which
 * codicon string drives the leading "thinking" cell on every render.
 *
 * turnState in [user, assistant-pending] AND (pidAlive OR mtime fresh)
 * -> activeFrames cycle. Otherwise idlePrefix.
 */

/** No-PID fallback window. mtime is doing both jobs (continuity AND
 * end-of-turn detection) so the default is widened from the
 * descriptor's tight live-PID safety net to ride through normal
 * between-tool deliberation. Classifier transitions still collapse
 * the widget the instant a real end state lands. */
const NO_PID_FALLBACK_MS = 30_000;

/** Activity-window length. Under live PID the descriptor's tight
 * default is just a safety net (PID-alive is the primary continuity
 * signal). With no PID:
 *   - `silentTurnCeilingMs` (when the provider supplies one AND a turn
 *     is in progress) rides a long silent reasoning gap, trusting the
 *     classifier as the real end-of-turn signal. Codex needs this.
 *   - otherwise the `NO_PID_FALLBACK_MS` window applies (idle tail, or
 *     a provider like Claude whose no-PID path is a lastKnown fallback
 *     that must not trust the classifier far enough to widen). */
export function effectiveActiveThresholdMs(
  pid: number | undefined,
  defaultMs: number,
  silentTurnCeilingMs?: number
): number {
  if (pid !== undefined) return defaultMs;
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
    now - data.transcriptMtimeMs <
    effectiveActiveThresholdMs(
      data.pid,
      descriptor.activeThresholdMs,
      descriptor.silentTurnCeilingMs
    )
  );
}

export interface PickPrefixArgs<TState extends { status: string }> {
  descriptor: SessionTokenWidgetDescriptor<TState>;
  data: SessionTokenRenderData;
  now: number;
}

export function pickPrefix<TState extends { status: string }>(
  args: PickPrefixArgs<TState>
): string {
  const { descriptor: d, data, now } = args;

  const turnInProgress =
    data.turnState === "user" || data.turnState === "assistant-pending";
  if (!turnInProgress || d.activeFrames.length === 0) return d.idlePrefix;

  // PID liveness keeps the indicator on through silent thinking
  // (deep Opus reasoning, slow tool calls). Mtime backstop is the
  // safety net when PID is unavailable or dead, and threshold widens to
  // 30s on lastKnown fallback where mtime is doing both jobs.
  const pidAlive = data.pid !== undefined && isPidAlive(data.pid);
  if (!pidAlive && !isTurnFresh(data, d, now)) return d.idlePrefix;

  const index = Math.floor(now / d.activeStepMs) % d.activeFrames.length;
  return d.activeFrames[index];
}
