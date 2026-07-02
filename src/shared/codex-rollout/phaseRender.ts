import type {
  BridgeStage,
  PlanState,
  StageDisplay,
  StageInfo,
  ToolCall,
} from "./types";

/**
 * Display-string builders for the canonical 5-stage bridge model.
 * Pure functions over `StageInfo` produced by `phaseParser`. No fs,
 * no state. Sits in its own file so the parser can stay a single
 * one-pass walk and the tooltip layer can swap renderers without
 * dragging the parser along.
 *
 * Consumers: session token widget tooltip, status bar tooltip in
 * adaptive mode.
 */

export function renderStageDisplay(info: StageInfo): StageDisplay {
  const fractionByStage: Record<BridgeStage, string> = {
    dispatched: "1/5",
    received: "2/5",
    working: "3/5",
    writing: "4/5",
    complete: "5/5",
  };
  const fraction = fractionByStage[info.stage];

  let label: string;
  switch (info.stage) {
    case "dispatched":
      label = "Sending";
      break;
    case "received":
      label = "Received";
      break;
    case "working":
      label = labelForWorking(info);
      break;
    case "writing":
      label = "Writing";
      break;
    case "complete":
      label = "Complete";
      break;
  }

  const planLine = renderPlanLine(info.plan);
  const toolLine = renderToolLine(info.activeTool, info.elapsedMs);

  return { fraction, label, planLine, toolLine };
}

/** Tool-name humanization for stage 3/5. Active tool wins over
 * reasoning-only when both are present - reasoning is often
 * interleaved with tool prep. */
function labelForWorking(info: StageInfo): string {
  const tool = info.activeTool;
  if (tool) {
    switch (tool.name) {
      case "update_plan":
        return "Planning";
      case "shell_command":
        return "Researching";
      case "web_search":
      case "web_search_call":
        return "Searching";
      case "read_file":
        return "Reading";
      default: {
        const short =
          tool.name.length > 0
            ? tool.name.replace(/_call$/, "").replace(/_/g, " ")
            : "tool";
        return `Using ${short}`;
      }
    }
  }
  if (info.reasoningTokens > 0) return "Thinking";
  return "Working";
}

function renderPlanLine(plan: PlanState | null): string | null {
  if (!plan || plan.totalSteps === 0) return null;
  const idx = plan.currentIndex >= 0 ? plan.currentIndex : plan.totalSteps;
  const display = Math.min(idx + 1, plan.totalSteps);
  const step = plan.steps[Math.max(0, Math.min(plan.currentIndex, plan.totalSteps - 1))];
  const text = step?.step ?? "";
  if (!text) return `Plan: step ${display} of ${plan.totalSteps}`;
  return `Plan: step ${display} of ${plan.totalSteps} - ${truncate(text, 80)}`;
}

function renderToolLine(tool: ToolCall | null, elapsedMs: number): string | null {
  if (!tool) return null;
  const elapsedLabel = formatElapsed(elapsedMs);
  return `Tool: ${tool.name} (${elapsedLabel} elapsed)`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

/** Coarse-grained: ms under one second, then m:ss. The session token
 * tooltip refreshes per tick so a finer resolution only churns the
 * dedup compare without changing the visible string. */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
