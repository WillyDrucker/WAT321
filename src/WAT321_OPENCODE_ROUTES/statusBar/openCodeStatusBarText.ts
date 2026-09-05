import * as vscode from "vscode";
import { SETTING } from "../../engine/settingsKeys";
import { formatPct } from "../../shared/ui/tokenFormatters";
import type { TpsThrottle } from "../../shared/ui/tpsThrottle";
import {
  formatRouteTokens,
  type Heartbeat,
  type readUsageSnapshot,
} from "./openCodeStatusBarSources";
import type { BridgeSessionTokens } from "./sessionTokensPoller";

/**
 * The text and change signatures of the OpenCode Routes status-bar
 * item. `openCodeStatusBarRefresh.ts` decides which state the widget
 * is in and applies the result, this file composes the strings.
 */

type SessionTokens = BridgeSessionTokens | null;

/** `tokens pct%` for the idle skin. Brand-new session with zero turns
 * reads as `0 0%` which is technically correct yet less useful than
 * the per-instance lifetime counter at idle. Show per-session only
 * once it has real tokens - otherwise fall to lifetime so the bar
 * always carries some signal. */
export function computeIdleSessionSuffix(args: {
  sessionTokens: SessionTokens;
  usage: ReturnType<typeof readUsageSnapshot>;
  activeInstanceId: string;
}): string {
  const { sessionTokens, usage, activeInstanceId } = args;
  if (sessionTokens && sessionTokens.contextUsed > 0) {
    return ` ${formatRouteTokens(sessionTokens.contextUsed)}${pctSuffix(sessionTokens, sessionTokens.contextUsed)}`;
  }
  const activeUsage = usage?.instances[activeInstanceId];
  const activeTotalTokens =
    typeof activeUsage?.input === "number" &&
    typeof activeUsage?.output === "number"
      ? activeUsage.input + activeUsage.output
      : 0;
  return activeTotalTokens > 0 ? ` ${formatRouteTokens(activeTotalTokens)}` : "";
}

/** ` pct%` of the context window for `used` tokens, or empty when the
 * window is unknown (Zen routes whose model is undisclosed). */
function pctSuffix(sessionTokens: BridgeSessionTokens, used: number): string {
  if (sessionTokens.contextWindow === null || sessionTokens.contextWindow <= 0) return "";
  const pct = Math.min(100, Math.round((used / sessionTokens.contextWindow) * 100));
  return ` ${formatPct(pct)}`;
}

export function composeInFlightText(args: {
  heartbeat: Heartbeat;
  idleAlias: string;
  sessionTokens: SessionTokens;
  sessionTokensSuffix: string;
  tpsThrottle: TpsThrottle;
  elapsedMs: number;
}): { text: string; alias: string } {
  const { heartbeat, idleAlias, sessionTokens, sessionTokensSuffix, tpsThrottle, elapsedMs } = args;
  const elapsedSec = Math.max(0, Math.floor(elapsedMs / 1000));
  // Mirror Claude/Codex session-tokens widgets: $(comment) <->
  // $(comment-discussion-quote) at 1Hz so "in progress" reads
  // consistently across all four backends.
  const oneHz = Math.floor(Date.now() / 1000) % 2 === 0;
  const icon = oneHz ? "$(comment)" : "$(comment-discussion-quote)";
  const alias = heartbeat.alias || idleAlias;
  // Project the current turn on top of the last completed turn's
  // cumulative. OpenCode's `/session/<id>/message` only surfaces the
  // assistant turn after completion, so `sessionTokens.contextUsed`
  // is frozen mid-dispatch. `liveTokens` from the heartbeat IS
  // updating continuously (~4Hz from the SSE / poll tap). Adding the
  // two gives a smooth count growth during dispatch with the session
  // percent remaining accurate against the context window. Post-
  // completion the heartbeat clears, the session poller picks up the
  // new cumulative on its next cycle, and the displayed count
  // settles from "projected" to "actual" (small under-count delta
  // because liveTokens approximates output-only, missing the input
  // tokens for this turn - usually 1-3%).
  const liveTokens = typeof heartbeat.tokens === "number" ? heartbeat.tokens : 0;
  const rawRate =
    typeof heartbeat.tokensPerSec === "number" ? heartbeat.tokensPerSec : 0;
  const throttledRate = tpsThrottle.next(rawRate) ?? 0;
  const tpsEnabled = vscode.workspace
    .getConfiguration("wat321")
    .get<boolean>(SETTING.enableTokensPerSecondCounters, false);
  const tpsLiveSuffix = tpsEnabled && throttledRate > 0 ? ` @ ${throttledRate}/s` : "";

  let projectedSuffix = sessionTokensSuffix;
  if (sessionTokens) {
    const projectedUsed = sessionTokens.contextUsed + liveTokens;
    // Brand-new session on its first heartbeat may have both
    // contextUsed and liveTokens at zero before the SSE tap delivers
    // its first sample. Keeping the idle suffix keeps the widget
    // showing motion instead of stalling on `0 0%`.
    if (projectedUsed > 0) {
      projectedSuffix = ` ${formatRouteTokens(projectedUsed)}${pctSuffix(sessionTokens, projectedUsed)}`;
    }
  }

  let stat: string;
  if (projectedSuffix.length > 0) {
    stat = `${projectedSuffix.trim()}${tpsLiveSuffix}`;
  } else if (liveTokens > 0) {
    stat = `${formatRouteTokens(liveTokens)}t${tpsLiveSuffix}`;
  } else {
    stat = `${elapsedSec}s`;
  }
  return { text: `${icon} ${alias} ${stat}`, alias };
}

/** Change signature for the idle tooltip, so the markdown rebuild
 * only runs when something it shows moved. */
export function idleSig(args: {
  idleAlias: string;
  needsKey: boolean;
  usageSig: string;
  activeBridgeAlias: string | null;
  sessionTokens: SessionTokens;
}): string {
  const { idleAlias, needsKey, usageSig, activeBridgeAlias, sessionTokens } = args;
  return `idle:${idleAlias}:${needsKey}:${usageSig}:${activeBridgeAlias ?? ""}:${sessionTokens?.contextUsed ?? 0}:${sessionTokens?.contextWindow ?? 0}:${sessionTokens?.autoCompactTokens ?? 0}`;
}
