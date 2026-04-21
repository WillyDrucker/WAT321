import * as vscode from "vscode";
import { getDisplayMode } from "../../engine/displayMode";
import { getWidgetPriority } from "../../engine/widgetCatalog";
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

export class SessionTokenWidget<TState extends { status: string }> implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private descriptor: SessionTokenWidgetDescriptor<TState>;
  private lastState: TState | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;

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
        this.item.text = `${d.idlePrefix} ${d.provider} -`;
        this.item.tooltip = `No active ${d.provider} session`;
        this.item.color = undefined;
        this.item.show();
        return;

      case "ok": {
        const data = d.getRenderData(state as TState & { status: "ok" });

        const effectiveCeiling = Math.max(0, data.ceiling - data.baselineTokens);
        const effectiveUsed = Math.max(0, data.contextUsed - data.baselineTokens);
        const pctOfCeiling = effectiveCeiling > 0
          ? Math.min(100, Math.round((effectiveUsed / effectiveCeiling) * 100))
          : 0;

        const mode = getDisplayMode();
        const prefix = this.currentPrefix(data);
        if (mode === "minimal" || mode === "compact") {
          this.item.text = `${prefix} ${d.provider} ${formatTokens(data.contextUsed)} ${formatPct(pctOfCeiling)}`;
        } else {
          this.item.text = `${prefix} ${d.provider} ${formatTokens(data.contextUsed)} / ${formatTokens(data.ceiling)} ${formatPct(pctOfCeiling)}`;
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
