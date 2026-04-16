import { getRemainingPct } from "../shared/codex-usage/formatters";
import { buildTooltip } from "../shared/codex-usage/tooltipBuilder";
import type { CodexUsageResponse } from "../shared/codex-usage/types";
import { getCodexTextColor, renderCodexBar } from "../shared/ui/heatmap";
import { UsageWidget, type UsageWidgetDescriptor } from "../shared/ui/usageWidget";
import { WIDGET_SLOT } from "../engine/widgetCatalog";

const descriptor: UsageWidgetDescriptor<CodexUsageResponse> = {
  id: "wat321.codexSession",
  name: "WAT321: Codex Usage (5 hour)",
  slot: WIDGET_SLOT.codexUsage5H,
  variant: "5h",
  nonOkOptions: {
    providerName: "Codex",
    providerKey: "codex",
    loadingText: "Codex (5 hour) $(loading~spin)",
  },
  getDisplayPct: (data) => {
    const usedPct = data.rate_limit?.primary_window?.used_percent ?? 0;
    return getRemainingPct(usedPct);
  },
  renderBar: (remainingPct, width) => renderCodexBar(100 - remainingPct, width),
  buildTooltip: (data) => buildTooltip(data),
  getTextColor: (mode, remainingPct) => getCodexTextColor(mode, 100 - remainingPct),
  formatText: (mode, pct, bar5, bar10) => {
    if (mode === "minimal") return `Codex 5h [${pct}%]`;
    if (mode === "compact") return `Codex (5h) ${bar5} ${pct}%`;
    return `Codex (5 hour) ${bar10} ${pct}%`;
  },
};

export class CodexUsage5hrWidget extends UsageWidget<CodexUsageResponse> {
  constructor() {
    super(descriptor);
  }
}
