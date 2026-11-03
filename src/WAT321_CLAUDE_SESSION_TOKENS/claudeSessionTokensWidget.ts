import type { BridgeStageReader } from "../engine/bridgeTypes";
import { WIDGET_SLOT } from "../engine/widgetCatalog";
import type { SessionTokenWidgetDescriptor } from "../shared/ui/sessionTokens/sessionTokenTypes";
import { SessionTokenWidget } from "../shared/ui/sessionTokens/sessionTokenWidget";
import type { ClaudeTokenWidgetState } from "./claudeSessionTokenTypes";

const descriptor: SessionTokenWidgetDescriptor<ClaudeTokenWidgetState> = {
  id: "wat321.sessionTokens",
  name: "Claude Session Tokens",
  slot: WIDGET_SLOT.claudeSessionTokens,
  provider: "Claude",
  whitePct: 90,
  yellowPct: 95,
  idlePrefix: "$(claude)",
  activeFrames: ["$(comment)", "$(comment-discussion-quote)"],
  activeStepMs: 1000,
  activeThresholdMs: 3_000,
  getRenderData: (state) => {
    const { session } = state;
    // Bars, percent, and the "N/M" numerator all measure against the
    // effective auto-compact trigger, the nominal target minus the
    // reserve Claude Code applies to overrides, so the displayed percent
    // agrees with the real fire point. The Claude settings provider owns
    // the reserve math.
    return {
      sessionId: session.sessionId,
      sessionTitle: session.sessionTitle,
      label: session.label,
      modelId: session.modelId,
      effort: session.effort,
      contextUsed: session.contextUsed,
      contextWindowSize: session.contextWindowSize,
      ceiling: session.autoCompactEffectiveTokens,
      baselineTokens: 0,
      lastWriteMs: session.lastActiveAt,
      turnState: session.turnState,
      pid: session.pid,
      lastActiveAt:
        session.source === "lastKnown" ? session.lastActiveAt : undefined,
      claudeTurnInfo: session.turnInfo,
      autoCompactEffectiveTokens: session.autoCompactEffectiveTokens,
      lastCompactTimestamp: session.turnInfo?.lastCompactTimestamp ?? null,
      tokensPerSecond: session.tokensPerSecond,
      compactState: session.compactState,
      workspaceSessionInventory: session.workspaceSessionInventory,
    };
  },
};

export class ClaudeSessionTokensWidget extends SessionTokenWidget<ClaudeTokenWidgetState> {
  constructor(bridgeStage: BridgeStageReader) {
    super(descriptor, bridgeStage);
  }
}
