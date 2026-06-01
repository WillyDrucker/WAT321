import type { ServiceState } from "../../engine/serviceTypes";
import type { KickstartGate } from "./kickstartGate";
import {
  logTransition,
  type TransitionReason,
  type TransitionStatus,
} from "./transitionLog";

/**
 * Dedicated writer for the per-workspace transition log. Wraps the
 * low-level `logTransition` so the base service file does not repeat
 * the record-assembly boilerplate three times (real transitions,
 * same-status heartbeats, absorbed rate-limits).
 *
 * Static per-service config (log path, provider key) is bound at
 * construction. Per-call evidence (counters, idle gap, poll cadence)
 * arrives as a `TransitionSnapshot` so the logger never reaches back
 * into the service class for state.
 */

export interface TransitionSnapshot {
  kickstartDiagnostics: ReturnType<KickstartGate["getDiagnostics"]>;
  consecutiveColdStartAbsorbs: number;
  idleForMs: number | null;
  pollIntervalMs: number;
}

export class TransitionLogger {
  constructor(
    private readonly path: string,
    private readonly providerKey: "claude" | "codex"
  ) {}

  /** Log a real state transition (from != to). Pulls cold-start /
   * retry-after / server-message fields off `nextState` only when the
   * destination is `rate-limited`. Optional `cacheAgeMs` distinguishes
   * cross-window cache adoption from this window's own re-read. */
  recordTransition(args: {
    from: TransitionStatus;
    to: TransitionStatus;
    reason: TransitionReason;
    nextState: ServiceState<unknown>;
    snapshot: TransitionSnapshot;
    cacheAgeMs?: number;
  }): void {
    const { from, to, reason, nextState, snapshot, cacheAgeMs } = args;
    const isRateLimited = nextState.status === "rate-limited";
    logTransition(this.path, {
      at: Date.now(),
      provider: this.providerKey,
      from,
      to,
      reason,
      isColdStart: isRateLimited ? nextState.isColdStart : undefined,
      consecutiveColdStartAbsorbs: snapshot.consecutiveColdStartAbsorbs,
      consecutiveFailedKickstarts:
        snapshot.kickstartDiagnostics.consecutiveFailedKickstarts,
      retryAfterMs: isRateLimited ? nextState.retryAfterMs : undefined,
      serverMessage: isRateLimited ? nextState.serverMessage : undefined,
      idleForMs: snapshot.idleForMs,
      pollIntervalMs: snapshot.pollIntervalMs,
      cacheAgeMs,
    });
  }

  /** Log a same-status heartbeat where the state machine did not
   * move (fetch-attempted, kickstart-skipped, recovery-ceiling-hit).
   * Captures polling activity in the log when state stays put. */
  recordHeartbeat(args: {
    status: TransitionStatus;
    reason: TransitionReason;
    snapshot: TransitionSnapshot;
  }): void {
    const { status, reason, snapshot } = args;
    logTransition(this.path, {
      at: Date.now(),
      provider: this.providerKey,
      from: status,
      to: status,
      reason,
      consecutiveColdStartAbsorbs: snapshot.consecutiveColdStartAbsorbs,
      consecutiveFailedKickstarts:
        snapshot.kickstartDiagnostics.consecutiveFailedKickstarts,
      idleForMs: snapshot.idleForMs,
      pollIntervalMs: snapshot.pollIntervalMs,
    });
  }

  /** Log an ok->ok 429 absorption. Status does not move (the widget
   * keeps showing the prior ok numbers), but the absorb counter +
   * idleForMs are the load-bearing signals for "why did the widget
   * go idle randomly" debugging - the user can see how many cold-
   * poll 429s stacked AND whether the activity probe agreed at each. */
  recordAbsorbedRateLimit(args: {
    serverMessage?: string;
    snapshot: TransitionSnapshot;
  }): void {
    const { serverMessage, snapshot } = args;
    logTransition(this.path, {
      at: Date.now(),
      provider: this.providerKey,
      from: "ok",
      to: "ok",
      reason: "fetch-429-absorbed",
      consecutiveColdStartAbsorbs: snapshot.consecutiveColdStartAbsorbs,
      consecutiveFailedKickstarts:
        snapshot.kickstartDiagnostics.consecutiveFailedKickstarts,
      serverMessage,
      idleForMs: snapshot.idleForMs,
      pollIntervalMs: snapshot.pollIntervalMs,
    });
  }
}
