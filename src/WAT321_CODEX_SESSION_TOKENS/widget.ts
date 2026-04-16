import { WIDGET_SLOT } from "../engine/widgetCatalog";
import {
  SessionTokenWidget,
  type SessionTokenWidgetDescriptor,
} from "../shared/ui/sessionTokenWidget";
import { CODEX_BASELINE_TOKENS } from "./autoCompactLimit";
import type { CodexTokenWidgetState } from "./types";

const descriptor: SessionTokenWidgetDescriptor<CodexTokenWidgetState> = {
  id: "wat321.codexSessionTokens",
  name: "Codex Session Tokens",
  slot: WIDGET_SLOT.codexSessionTokens,
  provider: "Codex",
  whitePct: 85,
  yellowPct: 90,
  getRenderData: (state) => {
    const { session } = state;
    return {
      sessionTitle: session.sessionTitle,
      label: session.label,
      modelId: session.modelSlug,
      contextUsed: session.contextUsed,
      contextWindowSize: session.contextWindowSize,
      ceiling: session.autoCompactTokens,
      baselineTokens: CODEX_BASELINE_TOKENS,
    };
  },
};

export class CodexSessionTokensWidget extends SessionTokenWidget<CodexTokenWidgetState> {
  constructor() {
    super(descriptor);
  }
}
