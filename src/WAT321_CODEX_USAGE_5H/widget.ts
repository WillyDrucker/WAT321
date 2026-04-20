import { getRemainingPct } from "../shared/codex-usage/formatters";
import { buildTooltip } from "../shared/codex-usage/tooltipBuilder";
import type { CodexUsageResponse } from "../shared/codex-usage/types";
import { renderCodexBar } from "../shared/ui/heatmap";
import { getCodexTextColor } from "../shared/ui/textColors";
import { UsageWidget, type UsageWidgetDescriptor } from "../shared/ui/usageWidget";
import { WIDGET_SLOT } from "../engine/widgetCatalog";

const descriptor: UsageWidgetDescriptor<CodexUsageResponse> = {
  id: "wat321.codexSession",
  name: "WAT321: Codex Usage (5h)",
  slot: WIDGET_SLOT.codexUsage5H,
  variant: "5h",
  nonOkOptions: {
    providerName: "Codex",
    providerIcon: "$(openai)",
    providerKey: "codex",
    loadingText: "$(openai) 5h $(loading~spin)",
  },
  getDisplayPct: (data) => {
    const usedPct = data.rate_limit?.primary_window?.used_percent ?? 0;
    return getRemainingPct(usedPct);
  },
  renderBar: (remainingPct, width) => renderCodexBar(100 - remainingPct, width),
  buildTooltip: (data) => buildTooltip(data),
  getTextColor: (mode, remainingPct) => getCodexTextColor(mode, 100 - remainingPct),
  formatText: (mode, pct, bar5, bar10) => {
    if (mode === "minimal") return `$(openai) 5h [${pct}%]`;
    if (mode === "compact") return `$(openai) 5h ${bar5} ${pct}%`;
    return `$(openai) 5h ${bar10} ${pct}%`;
  },
};

export class CodexUsage5hrWidget extends UsageWidget<CodexUsageResponse> {
  constructor() {
    super(descriptor);
  }
}
