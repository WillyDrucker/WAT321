import { WIDGET_SLOT } from "../engine/widgetCatalog";
import { getRemainingPct } from "../shared/codex-usage/formatters";
import { buildTooltip } from "../shared/codex-usage/tooltipBuilder";
import type { CodexUsageResponse } from "../shared/codex-usage/codexUsageTypes";
import { resolveCodexWindows } from "../shared/codex-usage/windows";
import { renderCodexBar } from "../shared/ui/heatmap";
import { getCodexTextColor } from "../shared/ui/textColors";
import { resolveUsageStyle } from "../shared/ui/usageDisplay";
import { UsageWidget, type UsageWidgetDescriptor } from "../shared/ui/usageWidget";

/**
 * The leading Codex usage bar. It renders the 5-hour window when Codex
 * publishes one, and the sole surviving window when Codex publishes only
 * one - which is the case today, since OpenAI retired the 5-hour cap and
 * now returns a single weekly limit.
 *
 * The bar deliberately stays in this slot in both layouts rather than
 * moving to the weekly slot, so it does not wander across the status bar
 * when the shape changes underneath it. Its caption follows the data:
 * "5h" normally, "5h/Weekly" once the two windows collapse into one, so
 * the single bar reads as covering both limits.
 */

/** The percent this widget draws, always taken from the resolved primary
 * row rather than from `primary_window` directly. Reading the raw slot is
 * what put a 7-day window behind a 5-hour label. */
function primaryUsedPct(data: CodexUsageResponse): number {
  return resolveCodexWindows(data).primary?.window.used_percent ?? 0;
}

const descriptor: UsageWidgetDescriptor<CodexUsageResponse> = {
  id: "wat321.codexSession",
  name: "WAT321: Codex Usage (5h)",
  slot: WIDGET_SLOT.codexUsage5H,
  providerName: "Codex",
  providerKey: "codex",
  getDisplayPct: (data) => {
    const remainingPct = getRemainingPct(primaryUsedPct(data));
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
  formatText: (mode, pct, bar5, bar10, data) => {
    // Caption comes from the resolved layout so it can never contradict
    // the window it sits on. Falls back to "5h" with no payload, which is
    // the scaffold case before the first fetch lands.
    const label = data !== null
      ? resolveCodexWindows(data).primary?.label ?? "5h"
      : "5h";
    if (mode === "minimal") return `$(openai) ${label} [${pct}%]`;
    if (mode === "compact") return `$(openai) ${label} ${bar5} ${pct}%`;
    return `$(openai) ${label} ${bar10} ${pct}%`;
  },
};

export class CodexUsage5hrWidget extends UsageWidget<CodexUsageResponse> {
  constructor() {
    super(descriptor);
  }
}
