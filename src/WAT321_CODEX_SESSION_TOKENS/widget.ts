import type { BridgeStageReader } from "../engine/bridgeTypes";
import { WIDGET_SLOT } from "../engine/widgetCatalog";
import {
  SessionTokenWidget,
  type SessionTokenWidgetDescriptor,
} from "../shared/ui/sessionTokens/sessionTokenWidget";
import { CODEX_BASELINE_TOKENS } from "./autoCompactLimit";
import type { CodexTokenWidgetState } from "./codexSessionTokenTypes";

const descriptor: SessionTokenWidgetDescriptor<CodexTokenWidgetState> = {
  id: "wat321.codexSessionTokens",
  name: "Codex Session Tokens",
  slot: WIDGET_SLOT.codexSessionTokens,
  provider: "Codex",
  whitePct: 75,
  yellowPct: 85,
  idlePrefix: "$(openai)",
  activeFrames: ["$(comment)", "$(comment-discussion-quote)"],
  activeStepMs: 1000,
  activeThresholdMs: 30_000,  // Codex has no PID signal - mtime-only with generous window
  // Native Codex turns reason silently for tens of seconds with no
  // rollout write (96s observed after task_started). The classifier
  // collapses the indicator instantly on a real end-state, so an
  // in-flight turn rides this wider window instead of dropping to idle
  // mid-reasoning. The EH bridge path is unaffected (it animates off
  // its own heartbeat, not rollout freshness).
  silentTurnCeilingMs: 180_000,
  getRenderData: (state) => {
    const { session } = state;
    return {
      sessionId: session.sessionId,
      sessionTitle: session.sessionTitle,
      label: session.label,
      modelId: session.modelSlug,
      contextUsed: session.contextUsed,
      contextWindowSize: session.contextWindowSize,
      ceiling: session.autoCompactTokens,
      baselineTokens: CODEX_BASELINE_TOKENS,
      // Freshness routes through the extension-observed growth
      // timestamp, not kernel mtime - see
      // CodexResolvedSession.lastActivityObservedAt for the Windows
      // open-handle mtime-lag rationale.
      transcriptMtimeMs: session.lastActivityObservedAt,
      turnState: session.turnState,
      stageInfo: session.stageInfo,
      lastCompactTimestamp: session.lastCompactTimestamp,
      tokensPerSecond: session.tokensPerSecond,
      compactState: session.compactState,
      workspaceSessionInventory: session.workspaceSessionInventory,
    };
  },
};

export class CodexSessionTokensWidget extends SessionTokenWidget<CodexTokenWidgetState> {
  constructor(bridgeStage: BridgeStageReader) {
    super(descriptor, bridgeStage);
  }
}
