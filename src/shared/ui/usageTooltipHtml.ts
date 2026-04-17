import * as vscode from "vscode";

/**
 * Shared HTML shell for the full / compact mode usage tooltips
 * (Claude and Codex). Minimal-mode tooltips render differently
 * (emoji bars) and stay in their provider tooltip builders.
 *
 * The shell is deliberately identical across providers so the two
 * surfaces stay pixel-consistent. Providers supply their own strings,
 * bar colors, and row semantics (used vs remaining) via the rows
 * array.
 */

export interface UsageTooltipRow {
  title: string;
  valueLabel: string;
  /** 0-100, fills the `<div>` bar width. */
  barFillPct: number;
  /** Hex color for the filled portion of the bar. */
  barColor: string;
  resetLine: string;
}

export interface UsageTooltipInput {
  /** Heading text, e.g. "Claude usage limits". */
  heading: string;
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

  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportHtml = true;
  md.appendMarkdown(`
<div style="min-width:280px;">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
<strong style="font-size:12px;">${input.heading}</strong>
<span style="font-size:11px;opacity:0.7;">${input.planLabel}</span>
</div>
${rowsHtml}
${footerHtml}
<div style="font-size:9px;opacity:0.4;margin-top:8px;">Updated ${new Date().toLocaleTimeString()}</div>
</div>
`);
  return md;
}
