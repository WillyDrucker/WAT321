import * as vscode from "vscode";
import type { TpsThrottle } from "../../shared/ui/tpsThrottle";
import {
  activeInstanceFrom,
  readActiveBridgeAlias,
  readConfigSnapshot,
  readHeartbeat,
  readUsageSnapshot,
  targetForInstance,
} from "./openCodeStatusBarSources";
import type { BridgeSessionTokensPoller } from "./sessionTokensPoller";
import { composeInFlightText, computeIdleSessionSuffix, idleSig } from "./openCodeStatusBarText";
import { buildOpenCodeRoutesTooltip } from "./tooltip";

/**
 * Stateful refresh for the OpenCode Routes status-bar item. Reads
 * config + heartbeat + usage + session-tokens, composes the tooltip and
 * the text (`openCodeStatusBarText.ts`), and applies them only when they
 * change (text and tooltip have independent change signatures so a
 * mid-dispatch phase transition does not reset the seconds counter
 * stride).
 *
 * Persisted state on `ctx.state` lets the function be called from a
 * setInterval without recapturing closures every tick:
 *   - lastText: skips the assignment when text is identical
 *   - lastTooltipSig: skips the markdown rebuild on identical sigs
 *   - lastInstanceId: detects active-instance switches so the TPS
 *     throttle drops its cadence cache and the new route's first
 *     reading lands immediately
 */

const STALE_HEARTBEAT_MULTIPLIER = 1.5;

export interface RefreshContext {
  item: vscode.StatusBarItem;
  sessionTokensPoller: BridgeSessionTokensPoller;
  tpsThrottle: TpsThrottle;
  state: {
    lastText?: string;
    lastTooltipSig?: string;
    lastInstanceId?: string;
  };
}

export function refreshStatusBarItem(ctx: RefreshContext): void {
  const { item, sessionTokensPoller, tpsThrottle, state } = ctx;

  const snap = readConfigSnapshot();
  if (!snap?.enabled || snap.instances.length === 0) {
    if (state.lastText !== undefined) {
      item.hide();
      state.lastText = undefined;
      state.lastTooltipSig = undefined;
    }
    return;
  }
  // In-flight heartbeat's instance overrides `last-used.json` since
  // last-used only flips on success at dispatch end. Falls back to
  // `activeInstanceFrom` between dispatches.
  const liveHeartbeat = readHeartbeat();
  const liveInstance = liveHeartbeat
    ? snap.instances.find((i) => i.id === liveHeartbeat.instanceId) ?? null
    : null;
  const active = liveInstance ?? activeInstanceFrom(snap);
  if (!active) {
    if (state.lastText !== undefined) {
      item.hide();
      state.lastText = undefined;
      state.lastTooltipSig = undefined;
    }
    return;
  }

  if (active.id !== state.lastInstanceId) {
    // Active instance switched - drop the prior route's TPS cadence
    // so the new route's first heartbeat reading appears immediately
    // rather than waiting out a stale throttle interval.
    tpsThrottle.reset();
    state.lastInstanceId = active.id;
  }

  const idleAlias = active.alias || active.id || "OpenCode";
  const retention = active.dataRetention;
  const needsKey = active.apiKeyMissing === true;
  // Idle icon: llama for Local LLM, opencode square for remote (Big
  // Pickle / Zen / etc.). The widget is tooltip-only across all
  // backends - session/instance management routes through the Epic
  // Handshake dropdown.
  const isLocal = active.kind === "local";
  const idleIcon = isLocal ? "$(wat321-llama)" : "$(wat321-opencode)";
  const usage = readUsageSnapshot();
  const usageSig = usage
    ? Object.entries(usage.instances)
        .map(([id, u]) => `${id}:${u.input}:${u.output}:${u.calls}`)
        .join("|")
    : "";

  // Active bridge alias for the displayed instance's target bucket.
  // Used by the tooltip + as the cache key for the session-tokens
  // poller. Status-bar text intentionally omits the S# - the
  // tokens-used + percentage carries enough signal.
  const activeBridgeTarget = targetForInstance(active);
  const activeBridgeAlias = activeBridgeTarget
    ? readActiveBridgeAlias(activeBridgeTarget)
    : null;

  // Per-session context-used + percentage from the OpenCode message
  // log. Falls back to legacy lifetime counter when no session
  // snapshot is available so a fresh-instance widget still shows
  // something useful at idle.
  const sessionTokens = activeBridgeTarget
    ? sessionTokensPoller.snapshot(activeBridgeTarget)
    : null;
  const sessionTokensSuffix = computeIdleSessionSuffix({
    sessionTokens,
    usage,
    activeInstanceId: active.id,
  });

  let text: string;
  let tooltipSig: string;
  let tooltip: vscode.MarkdownString;

  const startedMs = liveHeartbeat ? new Date(liveHeartbeat.startedAt).getTime() : NaN;
  const elapsedMs = Number.isFinite(startedMs) ? Date.now() - startedMs : 0;
  // Stale = heartbeat present but elapsed past timeout * multiplier (a
  // dispatch that ghosted without clearing). Falls through to the idle
  // skin rather than counting up forever.
  const stale =
    liveHeartbeat !== null &&
    Number.isFinite(startedMs) &&
    elapsedMs > liveHeartbeat.timeoutMs * STALE_HEARTBEAT_MULTIPLIER;

  if (liveHeartbeat && !stale) {
    const live = composeInFlightText({
      heartbeat: liveHeartbeat,
      idleAlias,
      sessionTokens,
      sessionTokensSuffix,
      tpsThrottle,
      elapsedMs,
    });
    text = live.text;
    tooltipSig = `live:${liveHeartbeat.currentPhase || "DISPATCH"}:${(liveHeartbeat.phaseTrace || []).length}:${usageSig}:${activeBridgeAlias ?? ""}:${sessionTokens?.contextUsed ?? 0}:${sessionTokens?.contextWindow ?? 0}:${sessionTokens?.autoCompactTokens ?? 0}`;
    tooltip = buildOpenCodeRoutesTooltip({
      hb: liveHeartbeat,
      catalogAlias: live.alias,
      catalogContextWindow: active.contextWindow ?? null,
      retention: liveHeartbeat.dataRetention ?? retention,
      needsKey: false,
      sessionTokens,
      target: activeBridgeTarget,
      activeBridgeAlias,
    });
  } else {
    // Idle, or a stale heartbeat treated as idle. The missing-key badge
    // shows only when truly idle (no heartbeat at all) - a stale
    // heartbeat means a dispatch ran, so the key is known good.
    const badge = !liveHeartbeat && needsKey ? " $(wat321-square-alert)" : "";
    text = `${idleIcon} ${idleAlias}${sessionTokensSuffix}${badge}`;
    tooltipSig = idleSig({
      idleAlias,
      needsKey,
      usageSig,
      activeBridgeAlias,
      sessionTokens,
    });
    tooltip = buildOpenCodeRoutesTooltip({
      hb: null,
      catalogAlias: idleAlias,
      catalogContextWindow: active.contextWindow ?? null,
      retention,
      needsKey,
      sessionTokens,
      target: activeBridgeTarget,
      activeBridgeAlias,
    });
  }

  if (text !== state.lastText) {
    item.text = text;
    state.lastText = text;
  }
  if (tooltipSig !== state.lastTooltipSig) {
    item.tooltip = tooltip;
    state.lastTooltipSig = tooltipSig;
  }
  item.show();
}
