import { buildTooltip } from "../shared/claude-usage/tooltipBuilder";
import type { UsageResponse } from "../shared/claude-usage/types";
import { getClaudeTextColor, renderClaudeBar } from "../shared/ui/heatmap";
import { UsageWidget, type UsageWidgetDescriptor } from "../shared/ui/usageWidget";
import { WIDGET_SLOT } from "../engine/widgetCatalog";

const descriptor: UsageWidgetDescriptor<UsageResponse> = {
  id: "wat321.session",
  name: "WAT321: Claude Usage (5hr)",
  slot: WIDGET_SLOT.claudeUsage5H,
  variant: "5h",
  nonOkOptions: {
    providerName: "Claude",
    providerKey: "claude",
    loadingText: "Claude (5hr) $(loading~spin)",
  },
  getDisplayPct: (data) => data.five_hour?.utilization ?? 0,
  renderBar: (pct, width) => renderClaudeBar(pct, width),
  buildTooltip: (data) => buildTooltip(data),
  getTextColor: (mode) => getClaudeTextColor(mode),
  formatText: (mode, pct, bar5, bar10) => {
    if (mode === "minimal") return `Claude 5h [${pct}%]`;
    if (mode === "compact") return `Claude (5h) ${bar5} ${pct}%`;
    return `Claude (5hr) ${bar10} ${pct}%`;
  },
};

export class ClaudeUsage5hrWidget extends UsageWidget<UsageResponse> {
  constructor() {
    super(descriptor);
  }
}
