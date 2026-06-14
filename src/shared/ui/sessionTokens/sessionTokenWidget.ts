import * as vscode from "vscode";
import type { BridgeStageReader } from "../../../engine/bridgeTypes";
import { getSessionTokenDisplayMode } from "../../../engine/displayMode";
import { getWidgetPriority } from "../../../engine/widgetCatalog";
import { SQUARE_ORANGE_COMPACT } from "../heatmap";
import {
  createCacheBannerLatch,
  type CacheBannerLatch,
} from "./sessionTokenCacheBannerLatch";
import {
  COMPACT_PROGRESS_COLOR,
  isOpenCodeDispatchActive,
  isPidAlive,
  TICK_MS,
  tpsSuffix,
} from "./sessionTokenHelpers";
import {
  effectiveActiveThresholdMs,
  isTurnFresh,
  pickPrefix,
} from "./sessionTokenPrefix";
import { buildSessionTokenTooltip } from "./sessionTokenTooltip";
import type { SessionTokenWidgetDescriptor } from "./sessionTokenTypes";
import { getSessionTokenColor } from "../textColors";
import { formatPct, formatTokens } from "../tokenFormatters";
import { TpsThrottle } from "../tpsThrottle";

export type {
  CacheEvent,
  CacheEventKind,
  ClaudeTurnInfo,
  SessionTokenRenderData,
  SessionTokenWidgetDescriptor,
} from "./sessionTokenTypes";

/**
 * Config-driven session-token widget. Provider-branded idle prefix +
 * DIY alternator "thinking" indicator while a turn is in progress.
 *
 * Active detection is three-layer:
 *   1. Classifier (`turnState`). `assistant-done` / `compact-end` /
 *      `interrupted` / `unknown` collapse to idle. Only `user` and
 *      `assistant-pending` keep the indicator active.
 *   2. PID liveness. When classifier says in-progress AND the
 *      session has a PID AND the process is alive, keep animating
 *      through silent thinking.
 *   3. Mtime backstop. PID dead / unavailable -> fall back to
 *      `now - mtime < activeThresholdMs`. Short window since the
 *      classifier catches end states - this only fires on CLI crash
 *      without a final marker ever landing.
 *
 * Ticker runs at TICK_MS, re-rendering from cached state + wall
 * clock. Frame index is wall-clock-derived so widgets stay in sync.
 * Ticker self-suspends when state leaves "ok" or no animation is
 * active, so idle widgets consume zero cycles.
 *
 * Cache-banner state and prefix selection are extracted into the
 * sibling `sessionTokenCacheBannerLatch` and `sessionTokenPrefix`
 * modules so this file owns only the VS Code status-bar lifecycle
 * and the render switch.
 */

export class SessionTokenWidget<TState extends { status: string }>
  implements vscode.Disposable
{
  private item: vscode.StatusBarItem;
  private descriptor: SessionTokenWidgetDescriptor<TState>;
  private lastState: TState | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** Push subscription to bridge phase + stage transitions so the
   * first bridge dispatch after a cold launch animates immediately
   * instead of waiting up to 15s for the next service poll. */
  private bridgeSub: { dispose(): void } | null = null;
  /** Display-refresh throttle for the visible TPS suffix. Per-widget -
   * the Claude widget's cadence does not drag the Codex widget. Reset
   * on session change so a fresh session's first reading appears
   * immediately. */
  private tpsThrottle = new TpsThrottle();
  /** Cache-banner state machine. Owns session-change watermark
   * adoption + LOAD/MISS flash timing. */
  private cacheBannerLatch: CacheBannerLatch = createCacheBannerLatch();

  constructor(
    descriptor: SessionTokenWidgetDescriptor<TState>,
    private readonly bridgeStage: BridgeStageReader
  ) {
    this.descriptor = descriptor;
    this.item = vscode.window.createStatusBarItem(
      descriptor.id,
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(descriptor.slot)
    );
    this.item.name = `WAT321: ${descriptor.provider} Session Tokens`;
    this.item.text = `${descriptor.idlePrefix} ${descriptor.provider} -`;
    this.item.tooltip = `No active ${descriptor.provider} session`;
    this.bridgeSub = bridgeStage.onChange(() => {
      this.render();
      this.ensureTicker();
    });
  }

  update(state: TState): void {
    this.lastState = state;
    this.render();
    this.ensureTicker();
  }

  /** True when an animation needs the 250ms sampling cadence:
   *   - bridge widget is mid-turn (any non-idle phase)
   *   - cache LOAD or MISS flash window is open
   *   - transcript was active within the last `activeThresholdMs`
   *
   * When all are false the widget renders a static idle state - the
   * ticker self-suspends until the next external update() restarts
   * it. Avoids the 4Hz tick during long idle stretches. */
  private animationsActive(): boolean {
    const now = Date.now();
    if (this.bridgeStage.snapshot().phase !== "idle") return true;
    if (this.descriptor.provider === "Claude" && isOpenCodeDispatchActive()) {
      return true;
    }
    if (this.cacheBannerLatch.isFlashing(now)) return true;
    if (this.lastState?.status === "ok") {
      const data = this.descriptor.getRenderData(
        this.lastState as TState & { status: "ok" }
      );
      // Compact-completion flash keeps the ticker alive ONLY while the
      // flashUntil window is open. The instant it elapses the next
      // render falls through to the normal path even before the
      // service emits its next state.
      if (
        data.compactState?.state === "flashing-completion" &&
        data.compactState.flashUntil !== null &&
        now < data.compactState.flashUntil
      ) {
        return true;
      }
      const turnInProgress =
        data.turnState === "user" || data.turnState === "assistant-pending";
      // PID + mtime backstop. Without it, a stale `assistant-pending`
      // classification (auto-compact summary the parser misreads as
      // mid-turn, partial entry from a Claude API error, cold launch
      // with the prior session's tail unchanged) keeps the ticker
      // ticking forever. A new prompt landing later still triggers
      // update() so this is a self-healing suspension.
      if (turnInProgress) {
        const pidAlive = data.pid !== undefined && isPidAlive(data.pid);
        if (pidAlive || isTurnFresh(data, this.descriptor, now)) return true;
      }
      const mtimeFresh =
        now - data.transcriptMtimeMs <
        effectiveActiveThresholdMs(data.pid, this.descriptor.activeThresholdMs);
      if (mtimeFresh) return true;
    }
    return false;
  }

  private ensureTicker(): void {
    const shouldTick =
      this.lastState?.status === "ok" && this.animationsActive();
    if (shouldTick && !this.ticker) {
      this.ticker = setInterval(() => {
        this.render();
        if (!this.animationsActive()) {
          if (this.ticker) {
            clearInterval(this.ticker);
            this.ticker = null;
          }
        }
      }, TICK_MS);
    } else if (!shouldTick && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private render(): void {
    const state = this.lastState;
    if (!state) return;
    const d = this.descriptor;

    switch (state.status) {
      case "not-installed":
        this.item.hide();
        return;

      case "no-session":
      case "waiting":
        this.item.text = `${d.idlePrefix} -`;
        this.item.tooltip = `No active ${d.provider} session`;
        this.item.color = undefined;
        this.item.show();
        return;

      case "ok": {
        const data = d.getRenderData(state as TState & { status: "ok" });
        const { sessionChanged } = this.cacheBannerLatch.observe(data);
        if (sessionChanged) this.tpsThrottle.reset();

        const effectiveCeiling = Math.max(0, data.ceiling - data.baselineTokens);
        const effectiveUsed = Math.max(0, data.contextUsed - data.baselineTokens);
        const pctOfCeiling =
          effectiveCeiling > 0
            ? Math.min(100, Math.round((effectiveUsed / effectiveCeiling) * 100))
            : 0;

        // Compact-completion flash. Both manual `/compact` and auto-
        // compact land their `compact_boundary` entry post-completion
        // with no observable pre-completion signal. The state machine
        // arms a brief flash on boundary detection so the user sees an
        // acknowledgment before the widget settles into the new post-
        // compact token count. Bar saturated at 5/5 + 100% - live
        // flashUntil check collapses the skin the instant the window
        // passes instead of waiting for the next service poll.
        const now = Date.now();
        if (
          data.compactState?.state === "flashing-completion" &&
          data.compactState.flashUntil !== null &&
          now < data.compactState.flashUntil
        ) {
          const filled = SQUARE_ORANGE_COMPACT.repeat(5);
          this.item.text = `${d.idlePrefix} ${filled} ${data.compactState.percent}%`;
          this.item.color = COMPACT_PROGRESS_COLOR;
          this.item.tooltip = `${d.provider} compact complete`;
          this.item.show();
          return;
        }

        const snapshot = this.bridgeStage.snapshot();
        const mode = getSessionTokenDisplayMode();
        const prefix = pickPrefix({
          descriptor: d,
          data,
          snapshot,
          now,
        });
        const banner = this.cacheBannerLatch.bannerAt(now);
        if (banner !== null) {
          // LOAD or MISS text persists for the full 2000ms window -
          // only the bullet positions blink at 500ms cadence. Prefix
          // stays visible so the brand icon and thinking indicator
          // ride through the flash. Tooltip keeps real data so
          // hovering during the flash still gives you session info.
          this.item.text = `${prefix} ${banner}`;
        } else if (mode === "minimal" || mode === "compact") {
          this.item.text = `${prefix} ${formatTokens(data.contextUsed)} ${formatPct(pctOfCeiling)}${tpsSuffix(this.tpsThrottle.next(data.tokensPerSecond), mode)}`;
        } else {
          this.item.text = `${prefix} ${formatTokens(data.contextUsed)} / ${formatTokens(data.ceiling)} ${formatPct(pctOfCeiling)}${tpsSuffix(this.tpsThrottle.next(data.tokensPerSecond), mode)}`;
        }

        this.item.color = getSessionTokenColor(
          pctOfCeiling,
          d.whitePct,
          d.yellowPct
        );

        this.item.tooltip = buildSessionTokenTooltip({
          provider: d.provider,
          sessionTitle: data.sessionTitle,
          label: data.label,
          modelId: data.modelId,
          contextUsed: data.contextUsed,
          contextWindowSize: data.contextWindowSize,
          ceiling: data.ceiling,
          baselineTokens: data.baselineTokens,
          lastActiveAt: data.lastActiveAt,
          stageInfo: data.stageInfo,
          claudeTurnInfo: data.claudeTurnInfo,
          turnState: data.turnState,
          autoCompactEffectiveTokens: data.autoCompactEffectiveTokens,
          codexEffort: snapshot.codexEffort,
          bridgeActive: snapshot.phase !== "idle",
          bridgeWaitTimeoutSec:
            d.provider === "Claude"
              ? snapshot.waitInfo?.timeoutSec ?? null
              : null,
          bridgeWaitMode:
            d.provider === "Claude"
              ? snapshot.waitInfo?.mode ?? "sync"
              : "sync",
          workspaceSessionInventory: data.workspaceSessionInventory,
        });
        this.item.show();
        return;
      }
    }
  }

  dispose(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    this.bridgeSub?.dispose();
    this.bridgeSub = null;
    this.item.dispose();
  }
}
