import * as vscode from "vscode";
import type { UsageResponse } from "./types";
import {
  formatSessionReset,
  formatWeeklyReset,
  getMaxLabel,
} from "./formatters";

export function buildTooltip(usage: UsageResponse): vscode.MarkdownString {
  const sPct = usage.five_hour?.utilization ?? 0;
  const sReset = usage.five_hour?.resets_at
    ? formatSessionReset(usage.five_hour.resets_at)
    : "unknown";
  const wPct = usage.seven_day?.utilization ?? 0;
  const wReset = usage.seven_day?.resets_at
    ? formatWeeklyReset(usage.seven_day.resets_at)
    : "unknown";
  const planLabel = getMaxLabel(usage.extra_usage);

  const sBarColor =
    sPct >= 80 ? "#ef4444" : sPct >= 50 ? "#f59e0b" : "#3b82f6";
  const wBarColor =
    wPct >= 80 ? "#ef4444" : wPct >= 50 ? "#f59e0b" : "#3b82f6";

  const md = new vscode.MarkdownString();
  md.isTrusted = true;
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
<div style="font-size:10px;opacity:0.6;margin-top:3px;">⧗ Resets in ${sReset}</div>
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
<div style="font-size:10px;opacity:0.6;margin-top:3px;">⧗ Resets ${wReset}</div>
</div>

<div style="font-size:9px;opacity:0.4;margin-top:8px;">Updated ${new Date().toLocaleTimeString()}</div>
</div>
`);
  return md;
}
