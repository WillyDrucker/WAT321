import * as vscode from "vscode";
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
const MAX_TITLE_LEN = 38;

export interface SessionTokenTooltipInput {
  provider: "Claude" | "Codex";
  sessionTitle: string;
  label: string;
  contextUsed: number;
  ceiling: number;
  /** Present on a `lastKnown` session, absent on a live session.
   * When present, the tooltip adds a "Last active: X ago" line so
   * the user knows they are looking at a snapshot. */
  lastActiveAt?: number;
}

export function buildSessionTokenTooltip(
  input: SessionTokenTooltipInput
): vscode.MarkdownString {
  const { provider, sessionTitle, label, contextUsed, ceiling, lastActiveAt } =
    input;

  // Codex's own TUI applies a 12,000-token baseline offset to both
  // numerator and denominator when computing the percentage (see
  // `TokenUsage::percent_of_context_window_remaining` in
  // `codex-rs/protocol/src/protocol.rs`). Mirror that here so the
  // tooltip's percentage matches Codex native exactly, and so it
  // stays aligned with the widget's own baseline-normalized usedPct.
  // Claude passes baseline=0, making this a no-op for the Claude
  // tooltip.
  const BASELINE_TOKENS = provider === "Codex" ? 12_000 : 0;
  const effectiveCeiling = Math.max(0, ceiling - BASELINE_TOKENS);
  const effectiveUsed = Math.max(0, contextUsed - BASELINE_TOKENS);
  const pctUsed =
    effectiveCeiling > 0
      ? Math.min(100, Math.round((effectiveUsed / effectiveCeiling) * 100))
      : 0;
  const bar = makeTokenBar(pctUsed);

  const title =
    sessionTitle && sessionTitle.length > MAX_TITLE_LEN
      ? sessionTitle.slice(0, MAX_TITLE_LEN) + "..."
      : sessionTitle;

  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportHtml = false;
  md.appendMarkdown(`**${provider} session token context**  \n`);
  if (title) {
    md.appendMarkdown(`"${title}"  \n`);
  }
  if (typeof lastActiveAt === "number") {
    md.appendMarkdown(`Last active: ${formatRelativeTime(lastActiveAt)}  \n`);
  }
  md.appendMarkdown(
    `${FOLDER} ${label} ${formatTokens(contextUsed)} / ${formatTokens(ceiling)}\n\n`
  );
  md.appendMarkdown(`${bar} ${formatPct(pctUsed)} used\n\n`);
  if (provider === "Claude") {
    // Claude's ceiling is the literal compact trigger
    // (`autoCompactPct * contextWindow`, e.g. 700k for extended
    // models at 70%). Compact fires at exactly the displayed ceiling,
    // so "Auto-Compact at {ceiling}" reads literally.
    md.appendMarkdown(
      `${CLAMP} Auto-Compact at ${formatTokens(ceiling)}`
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
  return md;
}
