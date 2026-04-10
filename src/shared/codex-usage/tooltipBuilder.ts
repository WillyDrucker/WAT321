import * as vscode from "vscode";
import type { CodexUsageResponse } from "./types";
import { makeBar, formatPlanLabel, formatWindowReset, getRemainingPct } from "./formatters";
import { getDisplayMode } from "../displayMode";

export function buildTooltip(usage: CodexUsageResponse): vscode.MarkdownString {
  const sPct = usage.rate_limit?.primary_window?.used_percent ?? 0;
  const sRemaining = getRemainingPct(sPct);
  const sReset = usage.rate_limit?.primary_window
    ? formatWindowReset(usage.rate_limit.primary_window.reset_at)
    : "unknown";
  const wPct = usage.rate_limit?.secondary_window?.used_percent ?? 0;
  const wRemaining = getRemainingPct(wPct);
  const wReset = usage.rate_limit?.secondary_window
    ? formatWindowReset(usage.rate_limit.secondary_window.reset_at)
    : "unknown";
  const planLabel = formatPlanLabel(usage.plan_type);
  const mode = getDisplayMode();

  let creditsText = "";
  if (usage.credits?.has_credits || usage.credits?.unlimited) {
    const balance = usage.credits.unlimited
      ? "Unlimited"
      : `$${usage.credits.balance ?? "0"}`;
    creditsText = `Credits: ${balance}`;
  }

  if (mode === "minimal") {
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = false;
    md.appendMarkdown(`**Codex usage limits** ${planLabel}\n\n`);
    md.appendMarkdown(`**5 hour usage limit** ${sRemaining}% remaining  \n`);
    md.appendMarkdown(`${makeBar(sPct)}  \n`);
    md.appendMarkdown(`⧗ Resets ${sReset}\n\n`);
    md.appendMarkdown(`**Weekly usage limit** ${wRemaining}% remaining  \n`);
    md.appendMarkdown(`${makeBar(wPct)}  \n`);
    md.appendMarkdown(`⧗ Resets ${wReset}\n\n`);
    if (creditsText) md.appendMarkdown(`${creditsText}\n\n`);
    md.appendMarkdown(`Updated ${new Date().toLocaleTimeString()}`);
    return md;
  }

  // Color based on remaining - low remaining = red/yellow
  const sBarColor =
    sRemaining <= 20 ? "#ef4444" : sRemaining <= 50 ? "#f59e0b" : "#22c55e";
  const wBarColor =
    wRemaining <= 20 ? "#ef4444" : wRemaining <= 50 ? "#f59e0b" : "#22c55e";

  const creditsLine = creditsText
    ? `<div style="font-size:10px;opacity:0.6;margin-top:6px;">${creditsText}</div>`
    : "";

  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = true;
  md.appendMarkdown(`
<div style="min-width:280px;">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
<strong style="font-size:12px;">Codex usage limits</strong>
<span style="font-size:11px;opacity:0.7;">${planLabel}</span>
</div>

<div style="margin-bottom:4px;">
<div style="display:flex;justify-content:space-between;margin-bottom:4px;">
<strong style="font-size:11px;">5 hour usage limit</strong>
<span style="font-size:11px;">${sRemaining}% remaining</span>
</div>
<div style="width:100%;height:8px;border-radius:4px;background:rgba(255,255,255,0.13);overflow:hidden;">
<div style="width:${Math.min(sRemaining, 100)}%;height:100%;border-radius:4px;background:${sBarColor};"></div>
</div>
<div style="font-size:10px;opacity:0.6;margin-top:3px;">⧗ Resets ${sReset}</div>
</div>

<hr style="border:none;border-top:1px solid rgba(255,255,255,0.12);margin:8px 0;">

<div>
<div style="display:flex;justify-content:space-between;margin-bottom:4px;">
<strong style="font-size:11px;">Weekly usage limit</strong>
<span style="font-size:11px;">${wRemaining}% remaining</span>
</div>
<div style="width:100%;height:8px;border-radius:4px;background:rgba(255,255,255,0.13);overflow:hidden;">
<div style="width:${Math.min(wRemaining, 100)}%;height:100%;border-radius:4px;background:${wBarColor};"></div>
</div>
<div style="font-size:10px;opacity:0.6;margin-top:3px;">⧗ Resets ${wReset}</div>
</div>

${creditsLine}

<div style="font-size:9px;opacity:0.4;margin-top:8px;">Updated ${new Date().toLocaleTimeString()}</div>
</div>
`);
  return md;
}
