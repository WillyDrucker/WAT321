import { buildTooltip } from "../shared/claudeUsage/claudeUsageTooltip";
import type { UsageResponse } from "../shared/claudeUsage/claudeUsageTypes";
import { fiveHourRetiredByPayload, fiveHourRetiredByPlan } from "../shared/claudeUsage/claudeUsageWindows";
import { renderClaudeBar } from "../shared/ui/heatmap";
import { getClaudeTextColor } from "../shared/ui/textColors";
import { resolveUsageStyle } from "../shared/ui/usageDisplay";
import { UsageWidget, type UsageWidgetDescriptor } from "../shared/ui/usageWidget";
import { WIDGET_SLOT } from "../engine/widgetCatalog";

/**
 * The leading Claude usage bar, for the 5-hour session window. It leaves
 * the status bar when the account has no 5-hour limit, as on a verified
 * Ultra plan, and the weekly bar carries on alone until the limit returns.
 */

const descriptor: UsageWidgetDescriptor<UsageResponse> = {
  id: "wat321.session",
  name: "WAT321: Claude Usage (5h)",
  slot: WIDGET_SLOT.claudeUsage5H,
  providerName: "Claude",
  providerKey: "claude",
  shouldHide: fiveHourRetiredByPayload,
  shouldHideWithoutData: fiveHourRetiredByPlan,
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

export class ClaudeUsage5hWidget extends UsageWidget<UsageResponse> {
  constructor() {
    super(descriptor);
  }
}
