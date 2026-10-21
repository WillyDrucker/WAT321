import * as vscode from "vscode";

/**
 * The two tooltip shells the Claude and Codex usage widgets share, so
 * the two providers stay pixel-consistent: an HTML layout for the full
 * and compact display modes, and an emoji-bar markdown layout for
 * minimal mode. Providers supply their own strings, bar colors or bar
 * text, and row semantics (used vs remaining) through the rows array.
 */

interface UsageTooltipRow {
  title: string;
  valueLabel: string;
  /** 0-100, fills the `<div>` bar width. */
  barFillPct: number;
  /** Hex color for the filled portion of the bar. */
  barColor: string;
  resetLine: string;
}

interface UsageTooltipInput {
  /** Heading text, e.g. "Claude usage limits". */
  heading: string;
  /** Codicon token rendered to the left of the heading, e.g.
   * `$(claude)` / `$(openai)`. Icon color is theme default - VS Code's
   * codicon CSS overrides inline styles on both the wrapper and the
   * codicon element itself in MarkdownString tooltips. */
  headingIcon?: string;
  /** Right-aligned plan label, e.g. "Max (20x)" / "Pro". */
  planLabel: string;
  /** One or more rows separated by a divider. */
  rows: UsageTooltipRow[];
  /** Optional footer line (Codex credits). */
  footer?: string;
}

const HOURGLASS = "\u{29D7}";

function renderRow(row: UsageTooltipRow): string {
  const fill = Math.min(100, Math.max(0, row.barFillPct));
  return `
<div>
<div style="display:flex;justify-content:space-between;margin-bottom:4px;">
<strong style="font-size:11px;">${row.title}</strong>
<span style="font-size:11px;">${row.valueLabel}</span>
</div>
<div style="width:100%;height:8px;border-radius:4px;background:rgba(255,255,255,0.13);overflow:hidden;">
<div style="width:${fill}%;height:100%;border-radius:4px;background:${row.barColor};"></div>
</div>
<div style="font-size:10px;opacity:0.6;margin-top:3px;">${HOURGLASS} ${row.resetLine}</div>
</div>`;
}

export function buildUsageTooltipHtml(input: UsageTooltipInput): vscode.MarkdownString {
  const rowsHtml = input.rows
    .map(renderRow)
    .join(`\n<hr style="border:none;border-top:1px solid rgba(255,255,255,0.12);margin:8px 0;">\n`);

  const footerHtml = input.footer
    ? `\n<div style="font-size:10px;opacity:0.6;margin-top:6px;">${input.footer}</div>\n`
    : "";

  // `&nbsp;&nbsp;` after the icon guarantees visible spacing since
  // plain whitespace collapses in markdown and `margin-right` on a
  // wrapping span is unreliable inside MarkdownString HTML.
  const headingIconHtml = input.headingIcon
    ? `${input.headingIcon}&nbsp;&nbsp;`
    : "";

  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportHtml = true;
  // Theme-icon support so the `$(claude)` / `$(openai)` token in the
  // heading renders as a codicon glyph instead of literal `$(...)`.
  md.supportThemeIcons = Boolean(input.headingIcon);
  md.appendMarkdown(`
<div style="min-width:280px;">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
<strong style="font-size:12px;">${headingIconHtml}${input.heading}</strong>
<span style="font-size:11px;opacity:0.7;">${input.planLabel}</span>
</div>
${rowsHtml}
${footerHtml}
<div style="font-size:9px;opacity:0.4;margin-top:8px;">Updated ${new Date().toLocaleTimeString()}</div>
</div>
`);
  return md;
}

/** A minimal-mode row. The bar is already-rendered text, the same
 * emoji bar the status bar shows, so heatmap rules stay uniform. */
interface UsageTooltipMinimalRow {
  title: string;
  valueLabel: string;
  bar: string;
  resetLine: string;
}

interface UsageTooltipMinimalInput {
  heading: string;
  headingIcon: string;
  planLabel: string;
  rows: UsageTooltipMinimalRow[];
  /** Footer notes, one paragraph each (Codex credits, no-data). */
  notes?: string[];
}

export function buildUsageTooltipMinimal(
  input: UsageTooltipMinimalInput
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  // HTML for `&nbsp;` to render as a non-breaking space (plain
  // whitespace collapses in markdown), theme icons so the brand
  // codicon renders.
  md.supportHtml = true;
  md.supportThemeIcons = true;
  md.appendMarkdown(
    `${input.headingIcon}&nbsp;&nbsp;**${input.heading}** ${input.planLabel}\n\n`
  );
  for (const row of input.rows) {
    md.appendMarkdown(`**${row.title}** ${row.valueLabel}  \n`);
    md.appendMarkdown(`${row.bar}  \n`);
    md.appendMarkdown(`${HOURGLASS} ${row.resetLine}\n\n`);
  }
  for (const note of input.notes ?? []) md.appendMarkdown(`${note}\n\n`);
  md.appendMarkdown(`Updated ${new Date().toLocaleTimeString()}`);
  return md;
}
