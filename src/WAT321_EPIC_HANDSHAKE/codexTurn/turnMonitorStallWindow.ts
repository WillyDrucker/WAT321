import type { StageInfo } from "../../shared/codex-rollout/turnStageTypes";

/**
 * Stall-window selector for `TurnMonitor`. Pure function so its
 * tool-window table can be reviewed in isolation - the monitor itself
 * only cares about "how long to arm the timer for", not the table of
 * empirical per-tool numbers below.
 *
 * `shell_command` runs can sit silent for minutes (Codex emits the
 * `function_call` entry at dispatch, then nothing until
 * `function_call_output` lands). Long-running reasoning is similar.
 * Quick tools (`update_plan`, `read_file`) stay on tighter windows so
 * a true stall still gets caught. With no active tool we look at
 * reasoning tokens - a reasoning-only phase can run long without any
 * tool call, signalled by `reasoningTokens > 0`.
 *
 * The floor (`stallFloorMs`) lets Fire-and-Forget ride out long chained
 * tool calls - Standard/Adaptive leave it at 0.
 */

const SHELL_COMMAND_WINDOW_MS = 180_000;
const REASONING_ONLY_WINDOW_MS = 180_000;
const WEB_SEARCH_WINDOW_MS = 120_000;
const QUICK_TOOL_WINDOW_MS = 60_000;
const UNKNOWN_TOOL_FLOOR_MS = 90_000;

export function stallWindowFor(
  lastInfo: StageInfo | null,
  defaultStallWindowMs: number,
  floorMs: number
): number {
  return Math.max(rawStallWindow(lastInfo, defaultStallWindowMs), floorMs);
}

function rawStallWindow(
  lastInfo: StageInfo | null,
  defaultStallWindowMs: number
): number {
  const tool = lastInfo?.activeTool?.name;
  if (!tool) {
    if (lastInfo && lastInfo.reasoningTokens > 0) return REASONING_ONLY_WINDOW_MS;
    return defaultStallWindowMs;
  }
  switch (tool) {
    case "shell_command":
      return SHELL_COMMAND_WINDOW_MS;
    case "web_search":
    case "web_search_call":
      return WEB_SEARCH_WINDOW_MS;
    case "update_plan":
    case "read_file":
      return QUICK_TOOL_WINDOW_MS;
    default:
      return Math.max(defaultStallWindowMs, UNKNOWN_TOOL_FLOOR_MS);
  }
}
