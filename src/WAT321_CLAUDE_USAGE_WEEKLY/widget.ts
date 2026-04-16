import { buildTooltip } from "../shared/claude-usage/tooltipBuilder";
import type { UsageResponse } from "../shared/claude-usage/types";
import { renderClaudeBar } from "../shared/ui/heatmap";
import { getClaudeTextColor } from "../shared/ui/textColors";
import { UsageWidget, type UsageWidgetDescriptor } from "../shared/ui/usageWidget";
import { WIDGET_SLOT } from "../engine/widgetCatalog";

const descriptor: UsageWidgetDescriptor<UsageResponse> = {
  id: "wat321.weekly",
  name: "WAT321: Claude Usage (Weekly)",
  slot: WIDGET_SLOT.claudeUsageWeekly,
  variant: "weekly",
  loadingText: "Claude weekly $(loading~spin)",
  loadingTooltip: "Fetching Claude usage data...",
  getDisplayPct: (data) => data.seven_day?.utilization ?? 0,
  renderBar: (pct, width) => renderClaudeBar(pct, width),
  buildTooltip: (data) => buildTooltip(data),
  getTextColor: (mode) => getClaudeTextColor(mode),
  formatText: (mode, pct, bar5, bar10) => {
    if (mode === "minimal") return `Claude weekly [${pct}%]`;
    if (mode === "compact") return `Claude weekly ${bar5} ${pct}%`;
    return `Claude weekly ${bar10} ${pct}%`;
  },
};

export class ClaudeUsageWeeklyWidget extends UsageWidget<UsageResponse> {
  constructor() {
    super(descriptor);
  }
}
