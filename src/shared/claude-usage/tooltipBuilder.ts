import * as vscode from "vscode";
import type { UsageResponse } from "./types";
import { getMaxLabel } from "./formatters";
import { formatFiveHourReset, formatWeeklyReset } from "../ui/resetFormatters";
import { getDisplayMode } from "../displayMode";
import { renderClaudeBar } from "../ui/heatmap";

function isoToMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

export function buildTooltip(usage: UsageResponse): vscode.MarkdownString {
  const sPct = usage.five_hour?.utilization ?? 0;
  const sResetMs = isoToMs(usage.five_hour?.resets_at);
  const sReset = sResetMs !== null ? formatFiveHourReset(sResetMs) : "Resets unknown";
  const wPct = usage.seven_day?.utilization ?? 0;
  const wResetMs = isoToMs(usage.seven_day?.resets_at);
  const wReset = wResetMs !== null ? formatWeeklyReset(wResetMs) : "Resets unknown";
  const planLabel = getMaxLabel(usage.extra_usage);
  const mode = getDisplayMode();

  if (mode === "minimal") {
    // Minimal tooltip shows emoji-style progress bars to match the
    // full-mode widget rendering. `renderClaudeBar` is the shared
    // entry point used by both the status bar widgets and this
    // tooltip, so heatmap/plain behavior stays in sync automatically.
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = false;
    md.appendMarkdown(`**Claude usage limits** ${planLabel}\n\n`);
    md.appendMarkdown(`**Current session (5hr)** ${sPct}% used  \n`);
    md.appendMarkdown(`${renderClaudeBar(sPct, 10)}  \n`);
    md.appendMarkdown(`\u{29D7} ${sReset}\n\n`);
    md.appendMarkdown(`**Weekly limits** ${wPct}% used  \n`);
    md.appendMarkdown(`${renderClaudeBar(wPct, 10)}  \n`);
    md.appendMarkdown(`\u{29D7} ${wReset}\n\n`);
    md.appendMarkdown(`Updated ${new Date().toLocaleTimeString()}`);
    return md;
  }

  const sBarColor =
    sPct >= 80 ? "#ef4444" : sPct >= 50 ? "#f59e0b" : "#3b82f6";
  const wBarColor =
    wPct >= 80 ? "#ef4444" : wPct >= 50 ? "#f59e0b" : "#3b82f6";

  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportHtml = true;
  md.appendMarkdown(`
<div style="min-width:280px;">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
<strong style="font-size:12px;">Claude usage limits</strong>
<span style="font-size:11px;opacity:0.7;">${planLabel}</span>
</div>

<div style="margin-bottom:4px;">
<div style="display:flex;justify-content:space-between;margin-bottom:4px;">
<strong style="font-size:11px;">Current session (5hr)</strong>
<span style="font-size:11px;">${sPct}% used</span>
</div>
<div style="width:100%;height:8px;border-radius:4px;background:rgba(255,255,255,0.13);overflow:hidden;">
<div style="width:${Math.min(sPct, 100)}%;height:100%;border-radius:4px;background:${sBarColor};"></div>
</div>
<div style="font-size:10px;opacity:0.6;margin-top:3px;">\u{29D7} ${sReset}</div>
</div>

<hr style="border:none;border-top:1px solid rgba(255,255,255,0.12);margin:8px 0;">

<div>
<div style="display:flex;justify-content:space-between;margin-bottom:4px;">
<strong style="font-size:11px;">Weekly limits</strong>
<span style="font-size:11px;">${wPct}% used</span>
</div>
<div style="width:100%;height:8px;border-radius:4px;background:rgba(255,255,255,0.13);overflow:hidden;">
<div style="width:${Math.min(wPct, 100)}%;height:100%;border-radius:4px;background:${wBarColor};"></div>
</div>
<div style="font-size:10px;opacity:0.6;margin-top:3px;">\u{29D7} ${wReset}</div>
</div>

<div style="font-size:9px;opacity:0.4;margin-top:8px;">Updated ${new Date().toLocaleTimeString()}</div>
</div>
`);
  return md;
}
