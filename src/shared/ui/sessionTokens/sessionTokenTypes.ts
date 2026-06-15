import type { StageInfo } from "../../codex-rollout/types";
import type { LastEntryKind } from "../../turnState";

/**
 * Type contracts shared by the session-token widget and its provider-
 * specific consumers (Claude / Codex parsers).
 *
 * Defined in `shared/ui` rather than per-tier so the generic widget
 * can reference these types without inverting the shared -> tool
 * dependency direction. Provider parser modules import + re-export
 * these names.
 */

/** Cache-event classification surfaced in the Claude session-token
 * tooltip. */
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
 * Populated on every poll when state is `ok`. */
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
   * A cache rebuild on the turn following a compact reads as yellow
   * LOAD (deliberate rebuild) rather than red MISS (involuntary
   * eviction). Null when the latest turn is not preceded by a compact
   * summary. */
  lastCompactTimestamp: number | null;
  /** Most recent classified cache event in the lookback window.
   * Tooltip-only readout - does not drive the banner. Read-only -
   * derived purely from the same transcript tail every other parser
   * field comes from. */
  mostRecentCacheEvent: CacheEvent | null;
}

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
  /** Most recent transcript / rollout file mtime in ms. Always present
   * when state is "ok". Backstop for the active indicator when PID is
   * unavailable / dead. */
  transcriptMtimeMs: number;
  /** Tail classification. Primary driver of the active indicator. */
  turnState: LastEntryKind;
  /** CLI process id for live sessions (Claude only). When present and
   * alive, keeps the active indicator on through silent thinking
   * periods that would otherwise trip the mtime backstop. Undefined
   * for lastKnown fallbacks and Codex. */
  pid?: number;
  /** When present, tooltip adds "Last active: X ago". Populated only
   * for stale (lastKnown) sessions - live sessions leave it undefined
   * so the tooltip does not read as "last active" on a currently-
   * active session. */
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
   * `isCompactSummary` user entry, Codex from the `compacted` /
   * `context_compacted` rollout entry. Null when no compact event is
   * in the scanned tail window. */
  lastCompactTimestamp: number | null;
  /** Live tokens-per-second estimate from the most recent transcript /
   * rollout delta. Null when no recent positive sample is available
   * (idle, just started, transcript not advancing). Surfaced in the
   * tooltip as a "Streaming ~X tps" line. */
  tokensPerSecond?: number | null;
  /** Compact-completion flash snapshot (Claude + Codex). When
   * `state: "flashing-completion"` the widget replaces the normal token
   * text with a saturated orange 100% bar for the flash window. May be
   * undefined during transitional states where the machine has not yet
   * emitted. The structural shape is the shared
   * `CompactFlashSnapshot` from `shared/polling/compactFlashMachine.ts`,
   * threaded through each provider widget's `getRenderData`. */
  compactState?: {
    state: "idle" | "flashing-completion";
    estimatedDurationMs: number;
    percent: number;
    barsFilled: number;
    /** Wall-clock ms at which a `flashing-completion` window expires.
     * The widget consults this on every ticker frame so the flash
     * collapses back to normal token rendering the instant the window
     * passes, instead of waiting for the next 15s service poll. Null
     * outside the flash state. */
    flashUntil: number | null;
  };
  /** Workspace session inventory snapshot. Total = open sessions in
   * this workspace for the provider - inProgress = subset with an
   * in-flight turn. Drives the multi-session tooltip disclosure -
   * surfaced as a tooltip line when total > 1 so the user can see
   * "this widget is watching one of N sessions" without a separate
   * pill. Defaults to {total:1, inProgress:0} in the common single-
   * session case. */
  workspaceSessionInventory?: { total: number; inProgress: number };
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
  /** In-flight-turn freshness window (ms) for a provider with no PID
   * handle. Codex exposes no process signal, so the indicator cannot
   * lean on PID liveness through a silent stretch, and modern Codex
   * reasons silently for tens of seconds with no rollout write, which
   * the tight `activeThresholdMs` gate reads as idle mid-turn. The
   * classifier owns end-of-turn detection (task_complete / turn_aborted
   * / final_answer collapse the indicator instantly), so this only
   * needs to outlast the longest silent gap and applies only while a
   * turn is in progress. A stale `assistant-pending` tail with no
   * end-state animates at most this long, then self-suspends. Omitted
   * for Claude, whose no-PID path is a lastKnown fallback that stays on
   * the tight window. */
  silentTurnCeilingMs?: number;
  /** Extract render data from an ok state. */
  getRenderData(state: TState & { status: "ok" }): SessionTokenRenderData;
}
