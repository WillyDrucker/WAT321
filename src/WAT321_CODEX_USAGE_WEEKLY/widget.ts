import { WIDGET_SLOT } from "../engine/widgetCatalog";
import { getRemainingPct } from "../shared/codex-usage/formatters";
import { buildTooltip } from "../shared/codex-usage/tooltipBuilder";
import type { CodexUsageResponse } from "../shared/codex-usage/types";
import { resolveCodexWindows } from "../shared/codex-usage/windows";
import { renderCodexBar } from "../shared/ui/heatmap";
import { getCodexTextColor } from "../shared/ui/textColors";
import { resolveUsageStyle } from "../shared/ui/usageDisplay";
import { UsageWidget, type UsageWidgetDescriptor } from "../shared/ui/usageWidget";

/**
 * The trailing Codex usage bar, shown only while Codex publishes two
 * rate-limit windows. OpenAI has retired the 5-hour cap and now returns a
 * single weekly window, so on that payload this widget takes itself off
 * the status bar and the sibling 5h widget carries the surviving limit
 * under a "5h/Weekly" caption.
 *
 * It hid nothing before, which is why the retired window rendered as a
 * permanently full green bar: an absent window reports 0% used, and 0%
 * used floors to 100% remaining.
 *
 * Hiding is driven entirely by the payload in hand, so if OpenAI restores
 * the second window this widget reappears on the next poll. Nothing is
 * remembered and nothing needs resetting. See `shared/codex-usage/windows.ts`.
 */

function weeklyUsedPct(data: CodexUsageResponse): number {
  return resolveCodexWindows(data).secondary?.window.used_percent ?? 0;
}

const descriptor: UsageWidgetDescriptor<CodexUsageResponse> = {
  id: "wat321.codexWeekly",
  name: "WAT321: Codex Usage (Weekly)",
  slot: WIDGET_SLOT.codexUsageWeekly,
  providerName: "Codex",
  providerKey: "codex",
  // Off the status bar only when Codex definitively published a single
  // window. A payload we could not classify leaves `hideWeekly` false, so
  // an empty or unreadable response keeps the bar up rather than dropping
  // it on a guess.
  shouldHide: (data) => resolveCodexWindows(data).hideWeekly,
  getDisplayPct: (data) => {
    const remainingPct = getRemainingPct(weeklyUsedPct(data));
    if (resolveUsageStyle("codex") === "used") {
      return 100 - remainingPct;
    }
    return remainingPct;
  },
  renderBar: (pct, width) => {
    const style = resolveUsageStyle("codex");
    const usedPct = style === "used" ? pct : 100 - pct;
    return renderCodexBar(usedPct, width, style);
  },
  buildTooltip: (data) => buildTooltip(data),
  getTextColor: (mode, pct) => {
    const usedPct = resolveUsageStyle("codex") === "used" ? pct : 100 - pct;
    return getCodexTextColor(mode, usedPct);
  },
  formatText: (mode, pct, bar5, bar10) => {
    if (mode === "minimal") return `$(openai) Weekly [${pct}%]`;
    if (mode === "compact") return `$(openai) Weekly ${bar5} ${pct}%`;
    return `$(openai) Weekly ${bar10} ${pct}%`;
  },
};

export class CodexUsageWeeklyWidget extends UsageWidget<CodexUsageResponse> {
  constructor() {
    super(descriptor);
  }
}
