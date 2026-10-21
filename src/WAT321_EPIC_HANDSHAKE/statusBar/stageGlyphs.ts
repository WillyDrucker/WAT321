import type { BridgeStage } from "../../engine/bridgeTypes";

/**
 * Status-bar glyph frames for the Epic Handshake stage walk. The
 * numbered squares match the `wat321-square-{one..five}` icon font
 * registrations in package.json.
 */

function stageGlyph(stage: BridgeStage): string {
  switch (stage) {
    case "dispatched":
      return "$(wat321-square-one)";
    case "received":
      return "$(wat321-square-two)";
    case "working":
      return "$(wat321-square-three)";
    case "writing":
      return "$(wat321-square-four)";
    case "complete":
      return "$(wat321-square-five)";
  }
}

/** 1Hz cycle frame for an active turn. Alternates the numbered stage
 * glyph (even seconds) with a directional or neutral frame (odd
 * seconds): arrow-right while outbound, blank while Codex works, and
 * arrow-left once `returning` is set or the turn is complete. Stage
 * meanings live in `bridgeStage/bridgeStageMap.ts`. */
export function adaptiveStageCycle(
  stage: BridgeStage,
  oneHz: boolean,
  returning: boolean
): string {
  if (oneHz) return stageGlyph(stage);
  switch (stage) {
    case "dispatched":
    case "received":
      return "$(wat321-square-arrow-right)";
    case "working":
      return "$(wat321-square)";
    case "writing":
      return returning ? "$(wat321-square-arrow-left)" : "$(wat321-square)";
    case "complete":
      return "$(wat321-square-arrow-left)";
  }
}
