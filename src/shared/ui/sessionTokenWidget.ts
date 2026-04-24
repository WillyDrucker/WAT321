import * as vscode from "vscode";
import { getDisplayMode } from "../../engine/displayMode";
import { getWidgetPriority } from "../../engine/widgetCatalog";
import { readBridgePhase } from "../bridgePhase";
import type { StageInfo } from "../codex-rollout/types";
import type { LastEntryKind } from "../transcriptClassifier";

/** Rich turn-state snapshot for the Claude session token tooltip.
 * Defined here (shared/ui) rather than in the Claude tool folder so
 * the generic widget can reference it without inverting the
 * shared -> tool dependency direction. Claude's parser module imports
 * this type back. Populated on every poll when state is `ok`. */
export interface ClaudeTurnInfo {
  /** Name of the most recent `tool_use` block if the last assistant
   * message has an unresolved tool call. Null when the last turn was
   * text-only or no tool calls have fired. */
  activeToolName: string | null;
  /** Count of `tool_use` blocks since the most recent user message. */
  toolCallCount: number;
  /** True if any of the last ~20 assistant entries carry a `thinking`
   * content block. */
  hasThinkingRecent: boolean;
  /** Output tokens on the most recent assistant turn. */
  outputTokens: number;
  /** `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
   * on the most recent assistant turn. */
  totalInputTokens: number;
  /** `cache_read_input_tokens` on the most recent assistant turn. */
  cachedInputTokens: number;
  /** `cache_creation_input_tokens` on the most recent assistant turn.
   * Substantial creation alongside near-zero cached read is the signal
   * for a real cache miss (TTL expired, context invalidated, auto-
   * compact fired); small creation is normal every-turn cache upkeep
   * and is not a miss. */
  cacheCreationTokens: number;
}
import { buildSessionTokenTooltip } from "./sessionTokenTooltip";
import { getSessionTokenColor } from "./textColors";
import { formatPct, formatTokens } from "./tokenFormatters";

/**
 * Config-driven session token widget with a provider-branded idle
 * prefix and a DIY alternator "thinking" indicator while a turn is
 * in progress.
 *
 * Active detection is a three-layer resolution:
 *   1. Classifier (primary end-state signal).
 *      `turnState` from the service's tail classification.
 *      `assistant-done` and `unknown` -> idle. Includes the
 *      interrupt marker `[Request interrupted by user]` which the
 *      classifier maps to `assistant-done`. Both graceful and
 *      interrupted turns resolve here reactively.
 *   2. PID liveness (continuity signal during silent thinking).
 *      When classifier says in-progress AND the session has a PID
 *      AND the process is alive, the widget keeps animating even
 *      when the transcript isn't being written - covers deep Opus
 *      reasoning TTFB and slow tool calls that otherwise leave the
 *      tail silent.
 *   3. Mtime backstop (hang safety net).
 *      If PID is dead or unavailable (lastKnown fallback, Codex,
 *      fork with no PID file), fall back to `now - mtime <
 *      activeThresholdMs`. Short window since the classifier
 *      catches normal end states and PID catches live thinking -
 *      this only fires on CLI crash without any marker ever landing.
 *
 * Ticker runs at TICK_MS, re-rendering from cached state plus the
 * current wall-clock. Frame index is wall-clock-derived so widgets
 * stay in sync. Ticker stops when state leaves "ok" so idle widgets
 * consume zero cycles.
 */

export interface SessionTokenRenderData {
  sessionTitle: string;
  label: string;
  modelId: string;
  contextUsed: number;
  contextWindowSize: number;
  ceiling: number;
  baselineTokens: number;
  /** Most recent transcript / rollout file mtime in ms. Always
   * present when state is "ok". Backstop for the active indicator
   * when PID is unavailable / dead. */
  transcriptMtimeMs: number;
  /** Tail classification. Primary driver of the active indicator. */
  turnState: LastEntryKind;
  /** CLI process id for live sessions (Claude only). When present
   * and alive, keeps the active indicator on through silent
   * thinking periods that would otherwise trip the mtime backstop.
   * Undefined for lastKnown fallbacks and Codex. */
  pid?: number;
  /** When present, tooltip adds "Last active: X ago". Populated only
   * for stale (lastKnown) sessions - live sessions leave it
   * undefined so the tooltip does not read as "last active" on a
   * currently-active session. */
  lastActiveAt?: number;
  /** Codex-only: stage + tool + plan + token breakdown parsed from
   * the rollout. Drives the tooltip richness during active turns
   * (current tool name, plan progress, reasoning-vs-output split,
   * cache hit rate). Undefined for Claude sessions. */
  stageInfo?: StageInfo;
  /** Claude-only: tool-use name, tool call counter, thinking-block
   * presence, and cache-hit token split from the most recent turn.
   * Undefined for Codex sessions. */
  claudeTurnInfo?: ClaudeTurnInfo;
  /** Claude-only: real compaction fire point in tokens. Distinct from
   * `ceiling` because recent Claude Code releases stack a reserve on
   * the override rather than replacing the default formula. Drives
   * the "Auto-Compact at ~X" tooltip line. Undefined for Codex. */
  autoCompactEffectiveTokens?: number;
}

export interface SessionTokenWidgetDescriptor<TState extends { status: string }> {
  id: string;
  name: string;
  slot: number;
  provider: "Claude" | "Codex";
  /** White/yellow warn thresholds for `getSessionTokenColor`. */
  whitePct: number;
  yellowPct: number;
  /** Codicon shown as the prefix when idle. */
  idlePrefix: string;
  /** Two or more codicon frames cycled while the transcript is
   * active. Frame n is chosen as
   * `Math.floor(now / activeStepMs) % frames.length`. */
  activeFrames: readonly string[];
  /** Ms per active-frame advance. */
  activeStepMs: number;
  /** Ms since last mtime bump before the widget returns to idle.
   * Keeps the indicator self-healing. */
  activeThresholdMs: number;
  /** Extract render data from an ok state. */
  getRenderData(state: TState & { status: "ok" }): SessionTokenRenderData;
}

const TICK_MS = 250;

/** `process.kill(pid, 0)` is the portable Node idiom for liveness
 * checking - signal 0 is test-only, never actually delivered.
 * ESRCH means the process is gone, EPERM means alive but we lack
 * permission to signal it (still alive for our purposes). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
}

/** Cache-miss flash window. Three-frame cycle over 2000ms:
 *
 *   0-500    MISS banner
 *   500-1000 normal tokens
 *   1000-2000 MISS banner (held)
 *
 * After 2000ms the widget returns to the normal readout permanently.
 * Widget's 250ms ticker samples the frame selector every render so the
 * alternation lands visibly despite each half-cycle being short. */
const CACHE_MISS_FLASH_MS = 2000;
/** Cache-miss definition: a new turn's usage bundle lands where
 * `cache_read_input_tokens` is near zero AND `cache_creation_input_tokens`
 * is substantial. Near-zero cached read means the prefix cache was not
 * used this turn; substantial creation means Claude had to rewrite
 * stable content that normally stays cached. Both signals together
 * isolate a real miss (TTL expired, context invalidated, auto-compact
 * fired) from normal every-turn cache writes (cache_creation is small,
 * cached read stays high).
 *
 * Thresholds:
 *   - CURR_MAX (cached read ceiling for "near zero"): 1,000 tokens.
 *     A real miss reads essentially nothing from cache.
 *   - CREATION_MIN (cache creation floor for "substantial"): 10,000
 *     tokens. Normal every-turn creation is typically a few hundred
 *     to a couple thousand tokens for just the new message block.
 *     10k+ means Claude rehashed system prompt + history.
 *
 * Also gated by usage-bundle change (`outputTokens:totalInput:cached`
 * signature) so a repeated poll that re-reads the same turn never
 * fires a duplicate miss flash. */
const CACHE_MISS_CACHED_MAX = 1_000;
const CACHE_MISS_CREATION_MIN = 10_000;
const CACHE_MISS_BANNER = "🔴MISS🔴";
/** Yellow LOAD banner for the FIRST qualifying cache-miss-pattern turn
 * after a widget mount. Distinguishes the expected cost of a fresh
 * session / deliberate reload from an unexpected miss. Same 2000ms
 * flash cadence as MISS; only the emoji color changes. Red MISS stays
 * reserved for every subsequent qualifying turn during the same
 * widget lifetime so a real alarm still reads as an alarm. */
const CACHE_LOAD_BANNER = "🟡LOAD🟡";

export class SessionTokenWidget<TState extends { status: string }> implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private descriptor: SessionTokenWidgetDescriptor<TState>;
  private lastState: TState | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** Signature of the last usage bundle we've seen on this widget
   * instance. Format: `output:totalInput:cached:creation`. Guards the
   * miss detector against firing twice on the same turn when multiple
   * polls read the same assistant entry (normal between the 15s poll
   * cadence and any intermediate triggerPoll). */
  private lastUsageSignature: string | null = null;
  private cacheMissFlashStartedAt: number | null = null;
  private cacheLoadFlashStartedAt: number | null = null;
  /** First qualifying cache-miss-pattern turn on this widget instance
   * fires LOAD (yellow); every subsequent one fires MISS (red). Flips
   * true the first time either banner is latched so the next unexpected
   * miss reads as an alarm. Widget instances are recreated on every
   * tier reactivate, so a deliberate extension reload resets this to
   * false and the next seeding turn reads LOAD as intended. */
  private hasEverFlashedCacheBanner = false;

  constructor(descriptor: SessionTokenWidgetDescriptor<TState>) {
    this.descriptor = descriptor;
    this.item = vscode.window.createStatusBarItem(
      descriptor.id,
      vscode.StatusBarAlignment.Right,
      getWidgetPriority(descriptor.slot)
    );
    this.item.name = `WAT321: ${descriptor.provider} Session Tokens`;
    this.item.text = `${descriptor.idlePrefix} ${descriptor.provider} -`;
    this.item.tooltip = `No active ${descriptor.provider} session`;
  }

  /** Detect a Claude turn that paid full input price because the
   * prefix cache was not usable (TTL expired after idle, context
   * invalidated, auto-compact ran, or this is the first-load seeding
   * after a fresh session / deliberate reload). Signal requires all
   * three:
   *   1. Usage bundle changed from the last poll (new turn landed,
   *      not a duplicate read of the same turn). Signature covers
   *      output + total input + cached + creation so any per-turn
   *      difference trips the check.
   *   2. `cachedInputTokens < CACHE_MISS_CACHED_MAX` - the cache
   *      was not substantially read this turn.
   *   3. `cacheCreationTokens >= CACHE_MISS_CREATION_MIN` - Claude
   *      rehashed enough content to indicate a real rebuild, not
   *      the small every-turn creation that is normal cache upkeep.
   *
   * First qualifying turn on this widget instance latches LOAD (yellow).
   * Every subsequent qualifying turn latches MISS (red). The distinction
   * separates "expected seeding cost after reload" from "unexpected
   * mid-session invalidation" so the alarm reading of red stays
   * meaningful. Widget instances are recreated on every tier
   * reactivate, so a deliberate reload resets the counter.
   *
   * Codex sessions never populate `claudeTurnInfo` so this no-ops on
   * that side. */
  private maybeLatchCacheMiss(claudeTurnInfo: ClaudeTurnInfo | undefined): void {
    if (claudeTurnInfo === undefined) return;
    const sig = `${claudeTurnInfo.outputTokens}:${claudeTurnInfo.totalInputTokens}:${claudeTurnInfo.cachedInputTokens}:${claudeTurnInfo.cacheCreationTokens}`;
    if (sig === this.lastUsageSignature) return;
    this.lastUsageSignature = sig;
    if (
      claudeTurnInfo.cachedInputTokens < CACHE_MISS_CACHED_MAX &&
      claudeTurnInfo.cacheCreationTokens >= CACHE_MISS_CREATION_MIN
    ) {
      if (this.hasEverFlashedCacheBanner) {
        this.cacheMissFlashStartedAt = Date.now();
      } else {
        this.cacheLoadFlashStartedAt = Date.now();
      }
      this.hasEverFlashedCacheBanner = true;
    }
  }

  /** Current cache-banner flash state, if any. Three-frame sequence
   * over 2000ms, identical cadence for LOAD (yellow) and MISS (red):
   *
   *   0-500    banner
   *   500-1000 tokens
   *   1000-2000 banner (held)
   *
   * After 2000ms the flash window ends. Widget's 250ms ticker samples
   * this every frame so the alternation lands visibly despite each
   * half-cycle being short. Returns which banner (if any) the current
   * frame should show so the render path can swap in the right emoji. */
  private currentCacheBanner(): string | null {
    const now = Date.now();
    if (this.cacheLoadFlashStartedAt !== null) {
      const elapsed = now - this.cacheLoadFlashStartedAt;
      if (elapsed < CACHE_MISS_FLASH_MS && (elapsed < 500 || elapsed >= 1000)) {
        return CACHE_LOAD_BANNER;
      }
    }
    if (this.cacheMissFlashStartedAt !== null) {
      const elapsed = now - this.cacheMissFlashStartedAt;
      if (elapsed < CACHE_MISS_FLASH_MS && (elapsed < 500 || elapsed >= 1000)) {
        return CACHE_MISS_BANNER;
      }
    }
    return null;
  }

  update(state: TState): void {
    this.lastState = state;
    this.render();
    this.ensureTicker();
  }

  private ensureTicker(): void {
    const shouldTick = this.lastState?.status === "ok";
    if (shouldTick && !this.ticker) {
      this.ticker = setInterval(() => this.render(), TICK_MS);
    } else if (!shouldTick && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private currentPrefix(data: SessionTokenRenderData): string {
    const d = this.descriptor;
    const now = Date.now();

    // Bridge turns carry their own "in flight" signal independent of
    // transcript mtime or PID liveness, so the bridge branch runs
    // first. Sequence from turn start:
    //   pre-ceremony (envelope queued, no heartbeat yet)
    //                                 force activeFrames so the
    //                                 widget does not flicker to
    //                                 idle or a stale turn glyph in
    //                                 the short window before the
    //                                 dispatcher writes its first
    //                                 heartbeat
    //   0-1000ms   debug-disconnect
    //   1000-2000  debug-connected
    //   2000-3000  debug-disconnect
    //   3000-4000  debug-connected   (4s ceremony floor regardless
    //                                 of how long dispatched lasts;
    //                                 starts on disconnect so the
    //                                 alternation reads as motion
    //                                 from the first frame)
    //   >=4000 and stage=dispatched  debug-connected (hold)
    //   stage>=received
    //     Claude widget + Standard/Adaptive wait modes: blank/claude
    //       blink at 1s (Claude is still blocking on the reply)
    //     Codex widget, or Claude in Fire-and-Forget: fall through
    //       to the provider's own activeFrames (normal thinking)
    // Bridge error / pause / completion all flip readBridgePhase to
    // null, which drops the branch and lets the widget render its
    // normal non-bridge behavior.
    const workspacePath =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const bridge = readBridgePhase(workspacePath);
    if (bridge !== null) {
      if (bridge.phase === "pre-ceremony") {
        const idx = Math.floor(now / d.activeStepMs) % d.activeFrames.length;
        return d.activeFrames[idx];
      }
      // phase === "in-turn"
      const elapsed = now - bridge.turnStartedAt;
      if (elapsed < 4000) {
        const frame = Math.floor(elapsed / 1000);
        return frame % 2 === 0 ? "$(debug-disconnect)" : "$(debug-connected)";
      }
      if (bridge.stage === "dispatched") return "$(debug-connected)";
      if (d.provider === "Claude" && bridge.claudeBlocking) {
        const tick = Math.floor(now / 1000) % 2;
        return tick === 0 ? "$(blank)" : "$(claude)";
      }
      // Fall through to normal activeFrames below: Codex animates its
      // native thinking during working/writing, and Claude under
      // Fire-and-Forget behaves the same as a non-bridge turn.
    }

    const turnInProgress =
      data.turnState === "user" || data.turnState === "assistant-pending";
    if (!turnInProgress || d.activeFrames.length === 0) return d.idlePrefix;

    // PID liveness keeps the indicator on through silent thinking
    // (no writes for extended Opus reasoning or slow tool calls).
    // Mtime backstop is the tight safety net when PID is unavailable
    // or dead - catches CLI crash without any marker ever landing.
    const pidAlive = data.pid !== undefined && isPidAlive(data.pid);
    const mtimeFresh = now - data.transcriptMtimeMs < d.activeThresholdMs;
    if (!pidAlive && !mtimeFresh) return d.idlePrefix;

    const index = Math.floor(now / d.activeStepMs) % d.activeFrames.length;
    return d.activeFrames[index];
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
        this.maybeLatchCacheMiss(data.claudeTurnInfo);

        const effectiveCeiling = Math.max(0, data.ceiling - data.baselineTokens);
        const effectiveUsed = Math.max(0, data.contextUsed - data.baselineTokens);
        const pctOfCeiling = effectiveCeiling > 0
          ? Math.min(100, Math.round((effectiveUsed / effectiveCeiling) * 100))
          : 0;

        const mode = getDisplayMode();
        const prefix = this.currentPrefix(data);
        const banner = this.currentCacheBanner();
        if (banner !== null) {
          // LOAD or MISS alternates with tokens across the 2000ms flash
          // window (see currentCacheBanner for the cadence). Prefix
          // stays visible throughout so the brand icon and thinking
          // indicator ride through the flash - only the tokens/percent
          // portion gets replaced. Tooltip keeps showing real data so
          // hovering during the flash still gives you session info.
          this.item.text = `${prefix} ${banner}`;
        } else if (mode === "minimal" || mode === "compact") {
          this.item.text = `${prefix} ${formatTokens(data.contextUsed)} ${formatPct(pctOfCeiling)}`;
        } else {
          this.item.text = `${prefix} ${formatTokens(data.contextUsed)} / ${formatTokens(data.ceiling)} ${formatPct(pctOfCeiling)}`;
        }

        this.item.color = getSessionTokenColor(pctOfCeiling, d.whitePct, d.yellowPct);

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
    this.item.dispose();
  }
}
