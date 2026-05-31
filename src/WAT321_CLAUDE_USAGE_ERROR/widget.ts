import type { UsageResponse } from "../shared/claude-usage/types";
import {
  UsageErrorWidget,
  type UsageErrorWidgetDescriptor,
} from "../shared/ui/usageErrorWidget";
import { WIDGET_SLOT } from "../engine/widgetCatalog";

/**
 * Claude error-status widget. Conditional: only visible while the
 * Claude usage service is in a non-ok state. Slot sits between the
 * Claude 5h and Claude weekly bars, so the user sees the one-word
 * state label adjacent to the bars it explains.
 */

const descriptor: UsageErrorWidgetDescriptor = {
  id: "wat321.claudeUsageStatus",
  name: "WAT321: Claude Usage Status",
  slot: WIDGET_SLOT.claudeUsageStatus,
  providerName: "Claude",
  providerKey: "claude",
};

export class ClaudeUsageErrorWidget extends UsageErrorWidget<UsageResponse> {
  constructor() {
    super(descriptor);
  }
}
