import type { CodexUsageResponse } from "../shared/codex-usage/types";
import {
  UsageErrorWidget,
  type UsageErrorWidgetDescriptor,
} from "../shared/ui/usageErrorWidget";
import { WIDGET_SLOT } from "../engine/widgetCatalog";

/**
 * Codex error-status widget. Conditional: only visible while the
 * Codex usage service is in a non-ok state. Slot sits between the
 * Codex 5h and Codex weekly bars so the label reads next to the bars
 * it explains. Mirrors `ClaudeUsageErrorWidget` so both providers
 * share the same disclosure shape.
 */

const descriptor: UsageErrorWidgetDescriptor = {
  id: "wat321.codexUsageStatus",
  name: "WAT321: Codex Usage Status",
  slot: WIDGET_SLOT.codexUsageStatus,
  providerName: "Codex",
  providerKey: "codex",
};

export class CodexUsageErrorWidget extends UsageErrorWidget<CodexUsageResponse> {
  constructor() {
    super(descriptor);
  }
}
