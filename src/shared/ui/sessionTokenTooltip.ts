import * as vscode from "vscode";
import { isKnownCodexModel } from "../codexModels";
import { formatModelDisplayName } from "../../engine/contracts";
import { renderStageDisplay } from "../codex-rollout/phaseRender";
import type { StageInfo } from "../codex-rollout/types";
import type { LastEntryKind } from "../transcriptClassifier";
import type { ClaudeTurnInfo } from "./sessionTokenWidget";
import { formatPct, formatTokens, makeTokenBar } from "./tokenFormatters";
import { formatRelativeTime } from "./relativeTime";

/**
 * Shared tooltip builder for the Claude and Codex session token
 * widgets. Both widgets surface the same information (provider,
 * optional session title, workspace label, current / ceiling token
 * count, progress bar, auto-compact threshold) - only the provider
 * name differs. Factoring the markdown build keeps the two widgets
 * thin and guarantees they stay visually consistent.
 */

const FOLDER = "\u{1F4C1}";
const CLAMP = "\u{1F5DC}\u{FE0F}";
/** Per-line cap for the session title. VS Code's MarkdownString
 * tooltip wraps at the rendered line, but we need a soft per-line
 * limit to prevent very long titles from creating an unreadably
 * wide tooltip. The wrap helper allows up to two visual lines before
 * ellipsis-truncating; line two ends at the same per-line cap. */
const MAX_TITLE_LINE_LEN = 38;


export interface SessionTokenTooltipInput {
  provider: "Claude" | "Codex";
  sessionTitle: string;
  label: string;
  /** Model slug (e.g. "claude-opus-4-6") for Claude, or model name
   * for Codex. Displayed as a friendly name in the tooltip header. */
  modelId?: string;
  contextUsed: number;
  /** Full context window size (e.g. 1,000,000 for 1M models). Shown
   * alongside the model name so the user knows the total capacity. */
  contextWindowSize?: number;
  ceiling: number;
  /** Tokens subtracted from both numerator and denominator before
   * computing the percentage. Codex passes `CODEX_BASELINE_TOKENS`
   * (12,000); Claude passes 0. */
  baselineTokens?: number;
  /** Present on a `lastKnown` session, absent on a live session.
   * When present, the tooltip adds a "Last active: X ago" line so
   * the user knows they are looking at a snapshot. */
  lastActiveAt?: number;
  /** Codex-only: stage + tool + plan snapshot from the rollout.
   * When turnState indicates an in-flight turn AND stageInfo is
   * populated, the tooltip adds Plan / Tool / Token-split lines so
   * the user sees what Codex is currently doing. */
  stageInfo?: StageInfo;
  /** Claude-only: tool_use name, tool call counter, thinking-block
   * presence, and cache-hit split. Rendered under the Auto-Compact
   * line when provider is Claude and turnState indicates in-flight. */
  claudeTurnInfo?: ClaudeTurnInfo;
  /** Current turn classification. Used to gate the stageInfo render:
   * the plan / tool / reasoning lines only make sense while the
   * session is actively mid-turn. */
  turnState?: LastEntryKind;
  /** Claude-only: real compaction fire point. When supplied, the
   * "Auto-Compact at ~X" line uses this value with a `~` prefix to
   * signal approximate, matching the Codex pattern. Falls back to
   * `ceiling` when absent (older callers, Codex path). */
  autoCompactEffectiveTokens?: number;
}

export function buildSessionTokenTooltip(
  input: SessionTokenTooltipInput
): vscode.MarkdownString {
  const {
    provider,
    sessionTitle,
    label,
    modelId,
    contextUsed,
    contextWindowSize,
    ceiling,
    baselineTokens = 0,
    lastActiveAt,
    stageInfo,
    claudeTurnInfo,
    turnState,
    autoCompactEffectiveTokens,
  } = input;

  const effectiveCeiling = Math.max(0, ceiling - baselineTokens);
  const effectiveUsed = Math.max(0, contextUsed - baselineTokens);
  const pctUsed =
    effectiveCeiling > 0
      ? Math.min(100, Math.round((effectiveUsed / effectiveCeiling) * 100))
      : 0;
  const bar = makeTokenBar(pctUsed);

  // Soft-wrap the title at MAX_TITLE_LINE_LEN by injecting a single
  // line break, then ellipsis-truncate only if the title would still
  // exceed two visual lines. Lets readable titles like 60-char
  // "Refactoring the WAT321 status bar item to be smaller" wrap
  // naturally instead of getting cut off mid-word.
  const title = wrapAndTruncateTitle(sessionTitle);

  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportHtml = false;
  md.appendMarkdown(`**${provider} session token context**  \n`);
  if (title) {
    // Two trailing spaces + newline = MarkdownString hard line break,
    // so the wrapped second line of a long title actually shows on its
    // own row instead of running together with the model line below.
    md.appendMarkdown(`"${title.replace(/\n/g, '"  \n"')}"  \n`);
  }
  if (modelId) {
    const modelName = formatModelDisplayName(modelId);
    const windowLabel = contextWindowSize
      ? ` (${formatTokens(contextWindowSize)} context)`
      : "";
    // Codex-only: flag a stored model slug that's absent from the
    // local `~/.codex/models_cache.json`. Every `thread/resume` ships
    // the stored slug to the API, so an unknown slug guarantees a 404
    // on the next prompt. Prefixing a warning badge lets the user
    // spot config drift before dispatching. Claude model IDs aren't
    // validated this way - Claude's slugs come from WAT321's own
    // MODEL_CONTEXT_WINDOWS table, not a user-editable cache.
    const codexModelInvalid =
      provider === "Codex" && !isKnownCodexModel(modelId);
    const prefix = codexModelInvalid ? "⚠ " : "";
    md.appendMarkdown(`${prefix}${modelName}${windowLabel}  \n`);
    if (codexModelInvalid) {
      md.appendMarkdown(
        `_Model not in your installed Codex's known set. The next prompt will fail; repair via the bridge menu._  \n`
      );
    }
  }
  if (typeof lastActiveAt === "number") {
    md.appendMarkdown(`Last active: ${formatRelativeTime(lastActiveAt)}  \n`);
  }
  md.appendMarkdown(
    `${FOLDER} ${label} ${formatTokens(contextUsed)} / ${formatTokens(ceiling)}\n\n`
  );
  md.appendMarkdown(`${bar} ${formatPct(pctUsed)} used\n\n`);
  if (provider === "Claude") {
    // Claude Code's percentage override stacks with an internal
    // reserve in recent releases: setting OVERRIDE=73 on a 1M window
    // triggers compaction around ~715k, not the nominal 730k the
    // ceiling math produces. `autoCompactEffectiveTokens` (when
    // supplied) captures that drift. Prefix `~` to signal approximate
    // so the label doesn't read as a guaranteed exact fire point.
    // Falls back to the exact ceiling when the caller didn't wire
    // the effective value through.
    const triggerTokens = autoCompactEffectiveTokens ?? ceiling;
    const prefix = autoCompactEffectiveTokens !== undefined ? "~" : "";
    md.appendMarkdown(
      `${CLAMP} Auto-Compact at ${prefix}${formatTokens(triggerTokens)}`
    );
  } else {
    // Codex's ceiling is the effective context window. Actual
    // compact fires earlier, at `context_window * 9 / 10` upstream.
    // Since our ceiling is `context_window * 95 / 100`, the trigger
    // works out to `ceiling * 90 / 95` = ~245k for current gpt-5.x
    // models. Integer math mirrors upstream's
    // `(context_window * 9) / 10` formulation. Assumes
    // `effective_context_window_percent` stays at 95 (the upstream
    // default and true for every model in models_cache.json today);
    // a future model with a different effective_pct would shift this.
    const compactTrigger = Math.floor((ceiling * 90) / 95);
    md.appendMarkdown(
      `${CLAMP} Auto-Compact ~${formatTokens(compactTrigger)}`
    );
  }

  // Codex mid-turn richness. Only render when a turn is in flight AND
  // we have structured rollout state. Idle sessions skip these lines
  // entirely so the tooltip stays short when nothing is happening.
  if (provider === "Codex" && stageInfo && turnStateIsActive(turnState)) {
    const display = renderStageDisplay(stageInfo);
    const lines: string[] = [];
    lines.push(`Codex: ${display.fraction} ${display.label}`);
    if (display.planLine) lines.push(display.planLine);
    if (display.toolLine) lines.push(display.toolLine);
    if (stageInfo.toolCallCount > 0) {
      lines.push(`${stageInfo.toolCallCount} tool call${stageInfo.toolCallCount === 1 ? "" : "s"} this turn`);
    }
    if (stageInfo.reasoningTokens > 0 || stageInfo.outputTokens > 0) {
      lines.push(
        `Thinking ${formatTokens(stageInfo.reasoningTokens)}, output ${formatTokens(stageInfo.outputTokens)} (last turn)`
      );
    }
    if (stageInfo.inputTokens > 0) {
      const pct = Math.round((stageInfo.cachedInputTokens / stageInfo.inputTokens) * 100);
      if (pct > 0) lines.push(`${pct}% cached`);
    }
    md.appendMarkdown(`\n\n${lines.join("  \n")}`);
  }

  // Claude mid-turn richness. Analog of the Codex block above, shaped
  // to Claude's transcript signals. Rendered only when actively mid-
  // turn so the tooltip stays short on idle sessions.
  if (provider === "Claude" && claudeTurnInfo && turnStateIsActive(turnState)) {
    const lines: string[] = [];
    if (claudeTurnInfo.activeToolName) {
      lines.push(`Tool: ${claudeTurnInfo.activeToolName}`);
    } else if (claudeTurnInfo.hasThinkingRecent) {
      lines.push("Thinking");
    }
    if (claudeTurnInfo.toolCallCount > 0) {
      lines.push(
        `${claudeTurnInfo.toolCallCount} tool call${claudeTurnInfo.toolCallCount === 1 ? "" : "s"} this turn`
      );
    }
    if (claudeTurnInfo.outputTokens > 0) {
      lines.push(`Output ${formatTokens(claudeTurnInfo.outputTokens)} (last turn)`);
    }
    if (claudeTurnInfo.totalInputTokens > 0) {
      const pct = Math.round(
        (claudeTurnInfo.cachedInputTokens / claudeTurnInfo.totalInputTokens) * 100
      );
      if (pct > 0) lines.push(`${pct}% cached`);
    }
    if (lines.length > 0) {
      md.appendMarkdown(`\n\n${lines.join("  \n")}`);
    }
  }

  return md;
}

/** Wrap a long session title across up to two lines, breaking on a
 * word boundary inside the first line's character budget. Titles
 * that fit on one line are returned unchanged; titles that exceed
 * two lines are ellipsis-truncated. Used to give long session names
 * a fair shot at full readability before falling back to truncation. */
function wrapAndTruncateTitle(sessionTitle: string | undefined): string {
  if (!sessionTitle) return "";
  if (sessionTitle.length <= MAX_TITLE_LINE_LEN) return sessionTitle;
  // Find the last space at or before MAX_TITLE_LINE_LEN so the wrap
  // happens between words. Falls back to a hard break if no space is
  // present in that window (e.g. a single very long token).
  const lastSpace = sessionTitle.lastIndexOf(" ", MAX_TITLE_LINE_LEN);
  const breakAt = lastSpace > 0 ? lastSpace : MAX_TITLE_LINE_LEN;
  const firstLine = sessionTitle.slice(0, breakAt).trimEnd();
  const remainder = sessionTitle.slice(breakAt).trimStart();
  if (remainder.length <= MAX_TITLE_LINE_LEN) {
    return `${firstLine}\n${remainder}`;
  }
  return `${firstLine}\n${remainder.slice(0, MAX_TITLE_LINE_LEN - 3)}...`;
}

/** True while the session is mid-turn - stage-info tooltip lines
 * only make sense during an in-flight response. `user` (waiting on
 * Codex) and `assistant-pending` (Codex actively working) qualify;
 * `assistant-done` and `unknown` are idle. */
function turnStateIsActive(turnState: LastEntryKind | undefined): boolean {
  return turnState === "user" || turnState === "assistant-pending";
}
