import type { BridgeStageReader } from "../engine/bridgeTypes";
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
  idlePrefix: "$(claude)",
  activeFrames: ["$(comment)", "$(comment-discussion-quote)"],
  activeStepMs: 1000,
  activeThresholdMs: 5_000,
  getRenderData: (state) => {
    const { session } = state;
    // Bars, percent, and the "N/M" numerator all use the effective
    // auto-compact trigger (nominal target minus the empirical reserve
    // Claude Code applies to overrides). Keeps the displayed % from
    // disagreeing with the actual fire point - if you set OVERRIDE=73
    // on a 1M window the widget reports 715k as 100% rather than the
    // nominal 730k. Source of truth lives in claudeSettings.ts.
    return {
      sessionId: session.sessionId,
      sessionTitle: session.sessionTitle,
      label: session.label,
      modelId: session.modelId,
      contextUsed: session.contextUsed,
      contextWindowSize: session.contextWindowSize,
      ceiling: session.autoCompactEffectiveTokens,
      baselineTokens: 0,
      transcriptMtimeMs: session.lastActiveAt,
      turnState: session.turnState,
      pid: session.pid,
      lastActiveAt:
        session.source === "lastKnown" ? session.lastActiveAt : undefined,
      claudeTurnInfo: session.turnInfo,
      autoCompactEffectiveTokens: session.autoCompactEffectiveTokens,
      lastCompactTimestamp: session.turnInfo?.lastCompactTimestamp ?? null,
    };
  },
};

export class ClaudeSessionTokensWidget extends SessionTokenWidget<WidgetState> {
  constructor(bridgeStage: BridgeStageReader) {
    super(descriptor, bridgeStage);
  }
}
