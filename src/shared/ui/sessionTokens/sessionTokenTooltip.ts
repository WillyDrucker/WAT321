import * as vscode from "vscode";
import { getCodexModelInfo, isKnownCodexModel } from "../../providers/codex/models";
import { formatModelDisplayName } from "../../../engine/contracts";
import type { ClaudeTurnInfo } from "./sessionTokenWidget";
import { formatPct, formatTokens, makeTokenBar } from "../tokenFormatters";
import { formatRelativeTime } from "../relativeTime";

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
 * ellipsis-truncating - line two ends at the same per-line cap. */
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
   * (12,000). Claude passes 0. */
  baselineTokens?: number;
  /** Present on a `lastKnown` session, absent on a live session.
   * When present, the tooltip adds a "Last active: X ago" line so
   * the user knows they are looking at a snapshot. */
  lastActiveAt?: number;
  /** Claude-only: tool_use name, tool call counter, thinking-block
   * presence, and cache-hit split. Rendered under the Auto-Compact
   * line when provider is Claude. */
  claudeTurnInfo?: ClaudeTurnInfo;
  /** Claude-only: real compaction fire point. When supplied, the
   * "Auto-Compact at ~X" line uses this value with a `~` prefix to
   * signal approximate, matching the Codex pattern. Falls back to
   * `ceiling` when absent (older callers, Codex path). */
  autoCompactEffectiveTokens?: number;
  /** Multi-session disclosure. When the user has more than one
   * session open in this workspace (e.g. two Claude TUIs in the
   * same project, two Codex rollouts in the same cwd), the tooltip
   * adds a line stating "Watching 1 of N sessions (M in progress)"
   * so the user knows this widget tracks ONE specific session and
   * understands why notifications may not match the focused window.
   * Suppressed when total <= 1. */
  workspaceSessionInventory?: { total: number; inProgress: number };
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
    claudeTurnInfo,
    autoCompactEffectiveTokens,
    workspaceSessionInventory,
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
    // Effort tag dot-separated between model and context window.
    // Codex: per-turn override > model's default_reasoning_level.
    // Claude: the persistent equivalent is whether extended thinking
    // is firing in recent turns (Claude has no UI knob like Codex's
    // effort, but the thinking-block presence is its closest analog).
    const effortLabel = resolveEffortLabel(provider, modelId, claudeTurnInfo);
    const effortSegment = effortLabel ? ` · ${effortLabel}` : "";
    md.appendMarkdown(`${prefix}Model: ${modelName}${effortSegment}${windowLabel}  \n`);
    if (codexModelInvalid) {
      md.appendMarkdown(
        `_Model not in your installed Codex's known set. The next prompt will fail - repair via the bridge menu._  \n`
      );
    }
  }
  if (typeof lastActiveAt === "number") {
    md.appendMarkdown(`Last active: ${formatRelativeTime(lastActiveAt)}  \n`);
  }
  // Multi-session disclosure. Surfaces only when the workspace has
  // more than one session open for this provider so the user can see
  // "this widget tracks one of several" without a separate pill.
  // The (M in progress) suffix only renders when at least one session
  // currently has a turn in flight, to avoid cluttering the line with
  // "0 in progress" in the common idle case.
  if (
    workspaceSessionInventory !== undefined &&
    workspaceSessionInventory.total > 1
  ) {
    const inProgressSuffix =
      workspaceSessionInventory.inProgress > 0
        ? ` (${workspaceSessionInventory.inProgress} in progress)`
        : "";
    md.appendMarkdown(
      `Watching 1 of ${workspaceSessionInventory.total} ${provider} sessions${inProgressSuffix}  \n`
    );
  }
  md.appendMarkdown(
    `${FOLDER} ${label} ${formatTokens(contextUsed)} / ${formatTokens(ceiling)}\n\n`
  );
  md.appendMarkdown(`${bar} ${formatPct(pctUsed)} used\n\n`);

  // Claude cache-event readout. Always shown when claudeTurnInfo is
  // present (regardless of in-flight). One blank line above so it
  // stands as its own clean line - no further detail trails the
  // description. Read-only: derived from the transcript tail by
  // parseMostRecentCacheEvent.
  if (provider === "Claude" && claudeTurnInfo?.mostRecentCacheEvent) {
    const ev = claudeTurnInfo.mostRecentCacheEvent;
    md.appendMarkdown(`\n\nMost recent cache event: ${ev.description}`);
  }

  // Auto-Compact lives at the bottom of every session-token tooltip.
  // Claude's effective trigger may differ from the nominal ceiling
  // when Claude Code's internal reserve stacks with the percentage
  // override - `autoCompactEffectiveTokens` captures that drift. Codex
  // computes the trigger from `(ceiling * 90) / 95` to mirror the
  // upstream `context_window * 9 / 10` formulation against our 95%
  // effective-window ceiling.
  if (provider === "Claude") {
    const triggerTokens = autoCompactEffectiveTokens ?? ceiling;
    const prefix = autoCompactEffectiveTokens !== undefined ? "~" : "";
    md.appendMarkdown(
      `\n\n${CLAMP} Auto-Compact at ${prefix}${formatTokens(triggerTokens)}`
    );
  } else {
    const compactTrigger = Math.floor((ceiling * 90) / 95);
    md.appendMarkdown(`\n\n${CLAMP} Auto-Compact ~${formatTokens(compactTrigger)}`);
  }

  return md;
}

/** Wrap a long session title across up to two lines, breaking on a
 * word boundary inside the first line's character budget. Titles
 * that fit on one line are returned unchanged - titles that exceed
 * two lines are ellipsis-truncated. */
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

/** Effort label that goes after the model name in the tooltip header.
 *
 * Codex: the model's `default_reasoning_level` from
 * `~/.codex/models_cache.json` so the user sees what Codex will run.
 *
 * Claude: there is no UI-level effort knob like Codex's. The closest
 * persistent analog is whether the most recent assistant turns
 * actually used extended thinking (the model emitting `thinking`
 * content blocks). Read this from `claudeTurnInfo.hasThinkingRecent`
 * rather than from a setting - on/off is the only signal we have.
 *
 * Returns null when there is nothing useful to display (Codex with no
 * model default, Claude not currently using thinking). */
function resolveEffortLabel(
  provider: "Claude" | "Codex",
  modelId: string,
  claudeTurnInfo: ClaudeTurnInfo | undefined
): string | null {
  if (provider === "Codex") {
    const effective = getCodexModelInfo(modelId)?.defaultEffort ?? null;
    if (effective === null) return null;
    return effective.charAt(0).toUpperCase() + effective.slice(1);
  }
  // Claude
  if (claudeTurnInfo?.hasThinkingRecent === true) return "Thinking";
  return null;
}
