import { getRemainingPct } from "../shared/codex-usage/formatters";
import { buildTooltip } from "../shared/codex-usage/tooltipBuilder";
import type { CodexUsageResponse } from "../shared/codex-usage/types";
import { renderCodexBar } from "../shared/ui/heatmap";
import { getCodexTextColor } from "../shared/ui/textColors";
import { resolveUsageStyle } from "../shared/ui/usageDisplay";
import { UsageWidget, type UsageWidgetDescriptor } from "../shared/ui/usageWidget";
import { WIDGET_SLOT } from "../engine/widgetCatalog";

const descriptor: UsageWidgetDescriptor<CodexUsageResponse> = {
  id: "wat321.codexSession",
  name: "WAT321: Codex Usage (5h)",
  slot: WIDGET_SLOT.codexUsage5H,
  providerName: "Codex",
  providerKey: "codex",
  getDisplayPct: (data) => {
    const usedPct = data.rate_limit?.primary_window?.used_percent ?? 0;
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
