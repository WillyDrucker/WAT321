import { getRemainingPct } from "../shared/codex-usage/formatters";
import { buildTooltip } from "../shared/codex-usage/tooltipBuilder";
import type { CodexUsageResponse } from "../shared/codex-usage/types";
import { renderCodexBar } from "../shared/ui/heatmap";
import { getCodexTextColor } from "../shared/ui/textColors";
import { resolveUsageStyle } from "../shared/ui/usageDisplay";
import { UsageWidget, type UsageWidgetDescriptor } from "../shared/ui/usageWidget";
import { WIDGET_SLOT } from "../engine/widgetCatalog";

const descriptor: UsageWidgetDescriptor<CodexUsageResponse> = {
  id: "wat321.codexWeekly",
  name: "WAT321: Codex Usage (Weekly)",
  slot: WIDGET_SLOT.codexUsageWeekly,
  providerName: "Codex",
  providerKey: "codex",
  getDisplayPct: (data) => {
    const usedPct = data.rate_limit?.secondary_window?.used_percent ?? 0;
    const remainingPct = getRemainingPct(usedPct);
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
