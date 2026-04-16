import { WIDGET_SLOT } from "../engine/widgetCatalog";
import {
  SessionTokenWidget,
  type SessionTokenWidgetDescriptor,
} from "../shared/ui/sessionTokenWidget";
import type { WidgetState } from "./types";

const descriptor: SessionTokenWidgetDescriptor<WidgetState> = {
  id: "wat321.sessionTokens",
  name: "Claude Session Tokens",
  slot: WIDGET_SLOT.claudeSessionTokens,
  provider: "Claude",
  whitePct: 90,
  yellowPct: 95,
  getRenderData: (state) => {
    const { session } = state;
    const ceiling = Math.round(
      (session.autoCompactPct / 100) * session.contextWindowSize
    );
    return {
      sessionTitle: session.sessionTitle,
      label: session.label,
      modelId: session.modelId,
      contextUsed: session.contextUsed,
      contextWindowSize: session.contextWindowSize,
      ceiling,
      baselineTokens: 0,
      lastActiveAt:
        session.source === "lastKnown" ? session.lastActiveAt : undefined,
    };
  },
};

export class ClaudeSessionTokensWidget extends SessionTokenWidget<WidgetState> {
  constructor() {
    super(descriptor);
  }
}
