import * as vscode from "vscode";
import type { BridgeStageReader } from "../../engine/bridgeTypes";
import { getDisplayMode } from "../../engine/displayMode";
import { getWidgetPriority } from "../../engine/widgetCatalog";
import type { StageInfo } from "../codex-rollout/types";
import type { LastEntryKind } from "../transcriptClassifier";
import { buildSessionTokenTooltip } from "./sessionTokenTooltip";
import { getSessionTokenColor } from "./textColors";
import { formatPct, formatTokens } from "./tokenFormatters";

/** Cache-event classification surfaced in the Claude session-token
 * tooltip. Defined here in shared/ui rather than in the Claude tool
 * folder so the generic widget can reference the type without inverting
 * the shared -> tool dependency direction. The Claude parser module
 * re-exports both names. */
export type CacheEventKind =
  | "HIT-clean"
  | "LOAD-compact"
  | "MISS-TTL"
  | "MISS-large-payload"
  | "MISS-unknown";

export interface CacheEvent {
  kind: CacheEventKind;
  /** Human-readable one-line description for the tooltip. */
  description: string;
  /** Timestamp (ms) of the assistant turn where the event was
   * detected. Null when no qualifying event was found. */
  ts: number | null;
}

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
  /** `cache_creation_input_tokens` on the most recent assistant turn. */
  cacheCreationTokens: number;
  /** Timestamp (ms) of the most recent `isCompactSummary` user entry
   * sitting immediately before the latest assistant turn in the tail.
   * Drives compact-aware banner classification: a cache rebuild on the
   * turn following a compact reads as yellow LOAD (deliberate rebuild)
   * rather than red MISS (involuntary eviction). Null when the latest
   * turn is not preceded by a compact summary. */
  lastCompactTimestamp: number | null;
  /** Most recent classified cache event in the lookback window.
   * Tooltip-only readout; does not drive the banner. Read-only -
   * derived purely from the same transcript tail every other parser
   * field comes from. See `parseMostRecentCacheEvent`. */
  mostRecentCacheEvent: CacheEvent | null;
}

/**
 * Config-driven session token widget with a provider-branded idle
 * prefix and a DIY alternator "thinking" indicator while a turn is
 * in progress.
 *
 * Active detection is a three-layer resolution:
 *   1. Classifier (primary end-state signal).
 *      `turnState` from the service's tail classification.
 *      `assistant-done`, `compact-end`, `interrupted`, and `unknown`
 *      -> idle. Only `user` and `assistant-pending` keep the
 *      indicator active. Auto-compact entries and user interrupts
 *      get their own kinds so the toast notifier can suppress them
 *      while the widget still resolves to idle here.
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
  /** Stable identifier for the session this render represents. The
   * widget compares it against its `lastSeenSessionId` to detect
   * session change and reset per-session latch state (LOAD/MISS
   * watermark, compact watermark) so each session gets its own
   * "first load" yellow banner. */
  sessionId: string;
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
  /** Provider-agnostic: timestamp (ms) of the most recent observed
   * compact event in the underlying transcript / rollout. Drives the
   * widget's compact-aware LOAD banner. Claude sources this from the
   * `isCompactSummary` user entry; Codex from the `compacted` /
   * `context_compacted` rollout entry. Null when no compact event is
   * in the scanned tail window. */
  lastCompactTimestamp: number | null;
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

/** Cache-banner flash window. 2000ms total; the LOAD/MISS text
 * persists the entire window. Bullets blink at a 500ms cadence
 * between colored emoji (red MISS / yellow LOAD) and black-circle
 * emoji (off frame). After 2000ms the widget returns to the normal
 * token readout. Widget's 250ms ticker samples the frame selector
 * every render so the bullet alternation lands visibly. */
const CACHE_BANNER_FLASH_MS = 2000;
/** Cache-rebuild detection. Two paths qualify a turn as a rebuild
 * event the user paid input price for:
 *
 *   1. Strict ratio rule (involuntary eviction signal).
 *      `cacheCreation >= CACHE_REBUILD_CREATION_MIN`
 *      AND `cacheCreation >= cachedInput * 2`.
 *      Creation dominates this turn 2:1 over reads. Catches mid-
 *      session full rebuilds (TTL expiry, server-side eviction,
 *      mystery cold-poll on healthy sessions) without false-firing
 *      on user-pasted big content (where reads stay large).
 *
 *   2. Compact-driven rule (deliberate rebuild signal).
 *      `awaitingCompactLoad === true`
 *      AND `cacheCreation >= CACHE_REBUILD_CREATION_MIN`.
 *      Compact (auto or /compact) caches a fresh summary alongside
 *      the surviving system prompt + tools, so creation is meaningful
 *      but reads are also non-trivial - the strict ratio gate would
 *      miss most of these. The marker (parser-detected
 *      `isCompactSummary` user entry) is the source of truth; we drop
 *      the ratio gate when it's set.
 *
 * Floor thresholds derived from sampling 25k+ unique signatures across
 * pre- and post-2026-04-24 sessions: tiny creation events are normal
 * mid-turn caching of new content; real rebuilds are always >= 5k. */
const CACHE_REBUILD_CREATION_MIN = 5_000;
const CACHE_REBUILD_RATIO_DENOM = 2;

/** Two-banner classification. Same 2000ms flash cadence for both;
 * the color signals cause:
 *
 *   yellow LOAD = deliberate cache build event - either first build
 *                 for this session lifetime (cold start, session
 *                 resume into a fresh widget) or a compact-driven
 *                 rebuild (auto or /compact). Either way the user
 *                 paid the input cost as part of an intentional
 *                 cache-load action.
 *   red    MISS = involuntary mid-session cache eviction (TTL,
 *                 server-side fault); user paid again unexpectedly.
 *
 * Each banner has an "on" form (colored emoji bullets) and an "off"
 * form (black circle bullets, U+26AB). Same emoji rendering family for
 * both frames, which is the only reliable way to keep the cell width
 * steady - mixing emoji with ASCII spaces or with codicons crosses
 * font tables and shifts the text by an unpredictable fraction on
 * every transition. The black circle reads as a quiet contrast pulse
 * against the colored on-frame; on dark themes it nearly disappears
 * for a "fades to blank" feel, on light themes it stays visible but
 * still pulses cleanly. Geometry is the load-bearing property either
 * way. */
const CACHE_LOAD_BANNER_ON = "🟡LOAD🟡";
const CACHE_LOAD_BANNER_OFF = "⚫LOAD⚫";
const CACHE_MISS_BANNER_ON = "🔴MISS🔴";
const CACHE_MISS_BANNER_OFF = "⚫MISS⚫";
/** 500ms per frame, four frames per banner cycle. Pattern (using
 * MISS): on (0-500) / off (500-1000) / on (1000-1500) / off (1500-2000).
 * Off frame swaps the colored circle for a black circle - same emoji
 * family means guaranteed equal width across frames. */
const CACHE_BANNER_FRAME_MS = 500;

export class SessionTokenWidget<TState extends { status: string }> implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private descriptor: SessionTokenWidgetDescriptor<TState>;
  private lastState: TState | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** Signature of the last usage bundle we've seen on this widget
   * instance. Format: `output:totalInput:cached:creation`. Guards the
   * latch against firing twice on the same turn when multiple polls
   * read the same assistant entry (normal between the 15s poll cadence
   * and any intermediate triggerPoll). Reset on session change. */
  private lastUsageSignature: string | null = null;
  private cacheLoadFlashStartedAt: number | null = null;
  private cacheMissFlashStartedAt: number | null = null;
  /** Tracks the session this widget last observed. When the underlying
   * session changes (user switched Claude Code projects, opened a
   * different conversation, etc.) we reset all per-session state so
   * the new session's first qualifying turn reads as LOAD, not MISS.
   * Null until the first ok-state poll lands. */
  private lastSeenSessionId: string | null = null;
  /** Most recent compact summary timestamp this widget has reacted
   * to. The parser reports `lastCompactTimestamp` whenever the latest
   * assistant turn is preceded by an `isCompactSummary` user entry; we
   * fire LOAD on the trailing rebuild only when this is newer than what
   * we've already classified. Adopted (not fired) on session change so
   * historical compacts visible in the tail don't fire spurious LOADs. */
  private lastSeenCompactTimestamp: number | null = null;
  /** True only when a deliberate rebuild is expected on the next
   * qualifying turn. Two events arm it:
   *   - Brand-new session attach (no usage in tail) - the first
   *     assistant turn IS the first cache build, fires LOAD.
   *   - `newCompactObserved` mid-session - the trailing turn after
   *     a compact event fires LOAD.
   *
   * Default false. Attaching to an existing session whose history
   * already contains usage means the first cache build happened in
   * a prior epoch we did not observe; LOAD must not fire on it.
   * The next qualifying rebuild flips this back to false; subsequent
   * rebuilds in the same epoch fire red MISS via the strict ratio
   * gate (cacheCreation >= cachedInput * 2). */
  private awaitingFirstLoad = false;
  /** Push subscription to bridge phase + stage transitions. Without
   * this, the very first bridge dispatch after a cold launch lands
   * between service polls and the widget's ticker never starts -
   * the ceremony / stage walk plays for the bridge widget but the
   * session-token widgets stay frozen on their idle prefix. The
   * subscription fires `render()` + `ensureTicker()` so the widget
   * picks up the transition immediately instead of waiting up to
   * the service's next 15s poll. */
  private bridgeSub: { dispose(): void } | null = null;

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

  /** Detect cache-rebuild events and latch the appropriate banner.
   * Two provider-specific paths converge on the same banner state.
   *
   * **Read-only contract (load-bearing).** This function and every
   * upstream parser it depends on are purely transcript-derived and
   * have **zero side effects** that could activate Claude or Codex.
   * No HTTP calls. No process spawns. No file writes outside the
   * widget's in-memory state. No notifications that fire CLI hooks.
   * The only outputs are widget state mutations (sig watermarks,
   * flash-start timestamps) that drive a 2-second visual pulse on
   * the status bar item. Confirmed structurally during the v1.2.10 /
   * v1.2.11 audit and reinforced in v1.2.12 - opening VS Code with
   * Claude installed does NOT cause the cache banner detection to
   * trigger any Anthropic-side activity, even if a LOAD or MISS
   * happens to fire on the first poll. Thresholds (CACHE_REBUILD_*)
   * are validated and stable; do not loosen them without a fresh
   * false-fire audit.
   *
   * Claude path (cc/cr tokens available):
   *   1. Strict ratio rule (involuntary eviction).
   *      `cacheCreation >= CACHE_REBUILD_CREATION_MIN`
   *      AND `cacheCreation >= cachedInput * CACHE_REBUILD_RATIO_DENOM`.
   *      Catches mid-session full rebuilds (TTL expiry, server-side
   *      eviction) without firing on normal incremental caching where
   *      reads dominate.
   *   2. Compact-driven rule (deliberate rebuild).
   *      `awaitingFirstLoad` AND `cacheCreation >= CREATION_MIN`.
   *      `awaitingFirstLoad` is armed only by an event that proves a
   *      deliberate rebuild is incoming: brand-new session attach (no
   *      usage in tail) or a fresh compact event observed live.
   *
   *   Banner choice:
   *     awaitingFirstLoad = true  -> yellow LOAD (deliberate event)
   *     awaitingFirstLoad = false -> red MISS via strict ratio gate
   *                                  only (involuntary event)
   *
   * Codex path (no token-level cache breakdown in rollouts):
   *   Marker-only. A new `compacted` / `context_compacted` rollout
   *   entry fires yellow LOAD immediately on detection. No MISS
   *   detection - Codex doesn't surface eviction signals. */
  private maybeLatchCacheBanner(data: SessionTokenRenderData): void {
    if (data.sessionId !== this.lastSeenSessionId) {
      // Session attach: adopt watermarks without firing on history
      // we never observed live. Three watermarks pinned here:
      //   - lastSeenSessionId tracks the current attachment target
      //   - lastSeenCompactTimestamp pins the compact watermark; future
      //     compacts must exceed it to count as "new"
      //   - lastUsageSignature pins the usage watermark to the existing
      //     tail's most recent assistant turn so the next poll sees no
      //     change and short-circuits before the gate
      //
      // awaitingFirstLoad gets armed only when a deliberate rebuild is
      // genuinely incoming. Two cases qualify:
      //   - Brand-new session with no prior usage in tail. The next
      //     assistant turn IS the first cache build, fire LOAD on it.
      //   - (Handled below) `newCompactObserved` while attached to an
      //     existing session - a compact lands and the trailing turn
      //     fires LOAD.
      // Attaching to an existing session whose history already has
      // usage does NOT arm the latch; the historical first cache
      // build belongs to an epoch we did not observe live.
      this.lastSeenSessionId = data.sessionId;
      this.lastSeenCompactTimestamp = data.lastCompactTimestamp;

      const info = data.claudeTurnInfo;
      const hasExistingUsage =
        info !== undefined &&
        (info.totalInputTokens > 0 ||
          info.cacheCreationTokens > 0 ||
          info.cachedInputTokens > 0);

      if (info !== undefined && hasExistingUsage) {
        this.lastUsageSignature = `${info.outputTokens}:${info.totalInputTokens}:${info.cachedInputTokens}:${info.cacheCreationTokens}`;
        this.awaitingFirstLoad = false;
      } else {
        this.lastUsageSignature = null;
        // Brand-new Claude session arms the latch so its first turn
        // fires LOAD as the genuine first cache build. Codex (info
        // undefined) leaves the latch off; the Codex path uses
        // newCompactObserved exclusively as its LOAD trigger.
        this.awaitingFirstLoad = info !== undefined;
      }
    }

    // Provider-agnostic compact detection. A newer compact timestamp
    // than what we adopted on session attach means a fresh compact
    // happened in this session epoch. Allow null watermark to permit
    // a session that had no compacts at attach time to still detect
    // its first-ever compact.
    const compactTs = data.lastCompactTimestamp;
    const newCompactObserved =
      compactTs !== null &&
      (this.lastSeenCompactTimestamp === null ||
        compactTs > this.lastSeenCompactTimestamp);

    if (newCompactObserved) {
      this.lastSeenCompactTimestamp = compactTs;
      this.awaitingFirstLoad = true;
    }

    const info = data.claudeTurnInfo;
    if (info === undefined) {
      // Codex path: marker-only. Fire LOAD immediately on a new
      // compact observation; Codex rollouts don't expose cache_creation
      // tokens for the strict ratio gate.
      if (newCompactObserved) {
        this.cacheLoadFlashStartedAt = Date.now();
        this.awaitingFirstLoad = false;
      }
      return;
    }

    // Claude path: token-gated detection.
    const sig = `${info.outputTokens}:${info.totalInputTokens}:${info.cachedInputTokens}:${info.cacheCreationTokens}`;
    if (sig === this.lastUsageSignature) return;
    this.lastUsageSignature = sig;

    const cc = info.cacheCreationTokens;
    const cr = info.cachedInputTokens;
    const meetsCreationFloor = cc >= CACHE_REBUILD_CREATION_MIN;
    if (!meetsCreationFloor) return;
    const meetsStrict = cc >= cr * CACHE_REBUILD_RATIO_DENOM;
    const meetsCompact = this.awaitingFirstLoad;
    if (!meetsStrict && !meetsCompact) return;

    const now = Date.now();
    if (this.awaitingFirstLoad) {
      this.cacheLoadFlashStartedAt = now;
      this.awaitingFirstLoad = false;
    } else {
      this.cacheMissFlashStartedAt = now;
    }
  }

  /** Current cache-banner flash state, if any. Four 500ms frames
   * across 2000ms, alternating colored emoji bullets and black-circle
   * emoji (off frame):
   *
   *   0-500    on   (colored emoji)
   *   500-1000 off  (black circle)
   *   1000-1500 on  (colored emoji)
   *   1500-2000 off (black circle)
   *
   * Text persists for the whole window so the user always sees LOAD
   * or MISS - only the bullets blink, like the Claude waiting cycle.
   * Returns the exact banner string to render (or null when no flash
   * is active). */
  private currentCacheBanner(): string | null {
    const now = Date.now();
    if (this.cacheLoadFlashStartedAt !== null) {
      const elapsed = now - this.cacheLoadFlashStartedAt;
      if (elapsed < CACHE_BANNER_FLASH_MS) {
        const onFrame = Math.floor(elapsed / CACHE_BANNER_FRAME_MS) % 2 === 0;
        return onFrame ? CACHE_LOAD_BANNER_ON : CACHE_LOAD_BANNER_OFF;
      }
    }
    if (this.cacheMissFlashStartedAt !== null) {
      const elapsed = now - this.cacheMissFlashStartedAt;
      if (elapsed < CACHE_BANNER_FLASH_MS) {
        const onFrame = Math.floor(elapsed / CACHE_BANNER_FRAME_MS) % 2 === 0;
        return onFrame ? CACHE_MISS_BANNER_ON : CACHE_MISS_BANNER_OFF;
      }
    }
    return null;
  }

  update(state: TState): void {
    this.lastState = state;
    this.render();
    this.ensureTicker();
  }

  /** True when an animation needs the 250ms sampling cadence:
   *   - bridge widget is mid-turn (logo blink / debug ceremony /
   *     stage cycle frames)
   *   - cache LOAD or MISS flash window is open
   *   - transcript was active within the last `activeThresholdMs`
   *     so the activeFrames cycle is progressing
   *
   * When all three are false the widget is rendering a static idle
   * state - the ticker can self-suspend until the next external
   * update() restarts it. Avoids the 4Hz tick during long idle
   * stretches when the user is not interacting with either CLI. */
  private animationsActive(): boolean {
    if (this.bridgeStage.snapshot().phase !== "idle") return true;
    if (this.cacheLoadFlashStartedAt !== null) {
      const elapsed = Date.now() - this.cacheLoadFlashStartedAt;
      if (elapsed < CACHE_BANNER_FLASH_MS) return true;
    }
    if (this.cacheMissFlashStartedAt !== null) {
      const elapsed = Date.now() - this.cacheMissFlashStartedAt;
      if (elapsed < CACHE_BANNER_FLASH_MS) return true;
    }
    if (this.lastState?.status === "ok") {
      const data = this.descriptor.getRenderData(
        this.lastState as TState & { status: "ok" }
      );
      const turnInProgress =
        data.turnState === "user" || data.turnState === "assistant-pending";
      if (turnInProgress) return true;
      const mtimeFresh =
        Date.now() - data.transcriptMtimeMs < this.descriptor.activeThresholdMs;
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
        // Self-suspend when animations stop. The next update() call
        // will re-evaluate and restart if needed.
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

  private currentPrefix(data: SessionTokenRenderData): string {
    const d = this.descriptor;
    const now = Date.now();

    // Bridge turns carry their own "in flight" signal independent of
    // transcript mtime or PID liveness, so the bridge branch runs
    // first. Sequence from turn start:
    //   pre-ceremony (envelope queued, no heartbeat yet)
    //                                 blink the provider logo
    //                                 (idlePrefix) against blank at
    //                                 1Hz. No real thinking is
    //                                 happening yet - just queue
    //                                 latency before the dispatcher
    //                                 writes its first heartbeat - so
    //                                 the activity-icon cycle would
    //                                 misrepresent state. Logo blink
    //                                 reads as "we know something is
    //                                 starting" without committing.
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
    //     Claude widget: 1Hz blank/claude blink for the entire bridge
    //       in-turn window, regardless of wait mode
    //     Codex widget: falls through to its own activeFrames
    //       (normal thinking)
    // The engine's BridgeStageCoordinator owns ceremony detection
    // (`snapshot.ceremonyActive`) and latched stage. Both widgets read
    // the same snapshot so they always observe the same phase + stage
    // at the same wall-clock instant. Bridge error / pause / completion
    // all collapse the snapshot to idle, dropping us out of this branch.
    const snapshot = this.bridgeStage.snapshot();
    // Fire-and-Forget returns Claude's MCP call immediately, so Claude
    // is not blocked on the bridge - it is free to do whatever it does
    // next (idle, drafting, tool calls). The Claude widget therefore
    // bypasses every bridge-driven prefix path under FaF and renders
    // purely from its own transcript activity (the normal turnInProgress
    // + activeFrames cycle below). The Codex widget still walks bridge
    // ceremony / stage 1 fallback under FaF because Codex is doing the
    // actual work regardless of which mode Claude waited in.
    const claudeBypassesBridge =
      d.provider === "Claude" && snapshot.waitMode === "fire-and-forget";
    if (snapshot.phase !== "idle" && !claudeBypassesBridge) {
      if (snapshot.phase === "pre-ceremony") {
        const tick = Math.floor(now / 1000) % 2;
        return tick === 0 ? "$(blank)" : d.idlePrefix;
      }
      if (snapshot.ceremonyActive) {
        if (d.provider === "Claude") {
          // Claude is the side that just composed and dispatched the
          // bridge tool call - native thinking cycle reads as "still
          // working" without the debug ceremony's "connecting" flavor
          // (Claude's MCP connection is established, nothing to
          // re-handshake). Falls into the same activeFrames it would
          // use for normal in-session thinking, picked by elapsed
          // ceremony time so the frame index is deterministic.
          const elapsed = now - (snapshot.heartbeat?.turnStartedAt ?? now);
          const index = Math.floor(elapsed / d.activeStepMs) % d.activeFrames.length;
          return d.activeFrames[index];
        }
        // Codex side: debug-disconnect / debug-connected ceremony
        // covers the window before codex has acknowledged the bridge
        // turn and started writing its rollout file.
        const elapsed = now - (snapshot.heartbeat?.turnStartedAt ?? now);
        const frame = Math.floor(elapsed / 1000);
        return frame % 2 === 0 ? "$(debug-disconnect)" : "$(debug-connected)";
      }
      if (d.provider === "Claude") {
        // Adaptive (and legacy Standard) blocks Claude's MCP call on
        // the bridge reply, so the Claude widget renders a 1Hz logo
        // blink to mark "Claude is waiting on Codex". FaF was already
        // routed around above via claudeBypassesBridge.
        const tick = Math.floor(now / 1000) % 2;
        return tick === 0 ? "$(blank)" : "$(claude)";
      }
      // Codex widget, stage 1 only (dispatched): the rollout file
      // does not exist yet, so the native `turnInProgress` check
      // below would leave the widget on its idle prefix. Run the same
      // 1Hz debug-disconnect/connected alternation the ceremony used,
      // so the post-ceremony handoff window reads as motion instead of
      // a static glyph waiting for Codex's first rollout write.
      //
      // Stage 2 (received) and beyond: Codex has written task_started
      // to its rollout, the transcript mtime is fresh, and the native
      // activeFrames cycle takes over below. Holding the debug-disconnect
      // glyph past stage 2 contradicts the bridge widget's stage walk
      // (which has confirmed receipt) and reads as "still connecting"
      // when codex is actually thinking.
      if (snapshot.latchedStage === "dispatched") {
        const tick = Math.floor(now / 1000) % 2;
        return tick === 0 ? "$(debug-disconnect)" : "$(debug-connected)";
      }
      // Stage 2+ (received/working/writing/complete): Codex's rollout
      // is alive, transcript mtime updates, `turnInProgress` flips
      // true, and the native activeFrames cycle takes over below.
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
        this.maybeLatchCacheBanner(data);

        const effectiveCeiling = Math.max(0, data.ceiling - data.baselineTokens);
        const effectiveUsed = Math.max(0, data.contextUsed - data.baselineTokens);
        const pctOfCeiling = effectiveCeiling > 0
          ? Math.min(100, Math.round((effectiveUsed / effectiveCeiling) * 100))
          : 0;

        const mode = getDisplayMode();
        const prefix = this.currentPrefix(data);
        const banner = this.currentCacheBanner();
        if (banner !== null) {
          // LOAD or MISS text persists for the full 2000ms flash
          // window; only the bullet positions blink between colored
          // emoji and black-circle emoji at a 500ms cadence (see
          // currentCacheBanner). Prefix stays visible throughout so
          // the brand icon and thinking indicator ride through the
          // flash - only the tokens/percent portion gets replaced.
          // Tooltip keeps showing real data so hovering during the
          // flash still gives you session info.
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
          codexEffort: this.bridgeStage.snapshot().codexEffort,
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
