import { getRemainingPct } from "../shared/codex-usage/formatters";
import { buildTooltip } from "../shared/codex-usage/tooltipBuilder";
import type { CodexUsageResponse } from "../shared/codex-usage/types";
import { renderCodexBar } from "../shared/ui/heatmap";
import { getCodexTextColor } from "../shared/ui/textColors";
import { UsageWidget, type UsageWidgetDescriptor } from "../shared/ui/usageWidget";
import { WIDGET_SLOT } from "../engine/widgetCatalog";

const descriptor: UsageWidgetDescriptor<CodexUsageResponse> = {
  id: "wat321.codexWeekly",
  name: "WAT321: Codex Usage (Weekly)",
  slot: WIDGET_SLOT.codexUsageWeekly,
  variant: "weekly",
  loadingText: "$(openai) Weekly $(loading~spin)",
  loadingTooltip: "Fetching Codex usage data...",
  getDisplayPct: (data) => {
    const usedPct = data.rate_limit?.secondary_window?.used_percent ?? 0;
    return getRemainingPct(usedPct);
  },
  renderBar: (remainingPct, width) => renderCodexBar(100 - remainingPct, width),
  buildTooltip: (data) => buildTooltip(data),
  getTextColor: (mode, remainingPct) => getCodexTextColor(mode, 100 - remainingPct),
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
