import { buildTooltip } from "../shared/claude-usage/tooltipBuilder";
import type { UsageResponse } from "../shared/claude-usage/types";
import { renderClaudeBar } from "../shared/ui/heatmap";
import { getClaudeTextColor } from "../shared/ui/textColors";
import { resolveUsageStyle } from "../shared/ui/usageDisplay";
import { UsageWidget, type UsageWidgetDescriptor } from "../shared/ui/usageWidget";
import { WIDGET_SLOT } from "../engine/widgetCatalog";

const descriptor: UsageWidgetDescriptor<UsageResponse> = {
  id: "wat321.session",
  name: "WAT321: Claude Usage (5h)",
  slot: WIDGET_SLOT.claudeUsage5H,
  providerName: "Claude",
  providerKey: "claude",
  getDisplayPct: (data) => {
    const usedPct = data.five_hour?.utilization ?? 0;
    if (resolveUsageStyle("claude") === "remaining") {
      return Math.max(0, Math.min(100, 100 - usedPct));
    }
    return usedPct;
  },
  renderBar: (pct, width) => {
    const style = resolveUsageStyle("claude");
    const usedPct = style === "remaining" ? 100 - pct : pct;
    return renderClaudeBar(usedPct, width, style);
  },
  buildTooltip: (data) => buildTooltip(data),
  getTextColor: (mode) => getClaudeTextColor(mode),
  formatText: (mode, pct, bar5, bar10) => {
    if (mode === "minimal") return `$(claude) 5h [${pct}%]`;
    if (mode === "compact") return `$(claude) 5h ${bar5} ${pct}%`;
    return `$(claude) 5h ${bar10} ${pct}%`;
  },
};

export class ClaudeUsage5hrWidget extends UsageWidget<UsageResponse> {
  constructor() {
    super(descriptor);
  }
}
