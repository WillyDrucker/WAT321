import { extractCurrentTurn } from "./phaseParser";
import {
  advanceStage,
  argumentsPreview,
  getPayloadField,
  getPayloadType,
  iterParsedEntries,
  parseIsoMs,
  parsePlanArguments,
  splitLines,
} from "./rolloutEntry";
import type {
  BridgeStage,
  PlanState,
  StageInfo,
  ToolCall,
} from "./types";

/**
 * Single-pass state machine over a Codex rollout tail that composes
 * the full `StageInfo` snapshot (stage 1-5, elapsed, plan state,
 * active tool, token breakdown). Scoped to the most recent turn via
 * `extractCurrentTurn`; long-lived rollouts contain many prior
 * turns and reading them unscoped would pollute every field and
 * latch stage permanently at `complete`.
 *
 * Cheap on every poll tick (15s in session tokens, 5s in the bridge
 * monitor) - one pass over the scoped tail.
 */

/** Post-tool reasoning threshold for promoting the turn to stage 4
 * (Finalizing). After Codex finishes its last function_call_output
 * it typically reasons for 10-30s before the final answer streams.
 * One function_call_output plus a run of reasoning entries with no
 * intervening new function_call is a reliable wrap-up signal. */
const POST_TOOL_REASONING_THRESHOLD = 2;

export function parseStageInfo(tail: string): StageInfo {
  const scoped = extractCurrentTurn(tail);
  const lines = splitLines(scoped);

  let stage: BridgeStage = "dispatched";
  let taskStartedAt: number | null = null;
  let plan: PlanState | null = null;
  let toolCallCount = 0;
  let activeTool: ToolCall | null = null;
  let reasoningTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let inputTokens = 0;
  const tryAdvance = (target: BridgeStage): void => {
    stage = advanceStage(stage, target);
  };

  const pendingByCallId = new Map<string, ToolCall>();
  let functionCallOutputsSeen = 0;
  let reasoningSinceLastTool = 0;

  for (const entry of iterParsedEntries(lines)) {
    const { timestamp } = entry;
    const payloadType = getPayloadType(entry);

    if (entry.type === "event_msg" && payloadType === "task_started") {
      if (taskStartedAt === null) taskStartedAt = parseIsoMs(timestamp);
      tryAdvance("received");
      continue;
    }

    if (entry.type === "event_msg" && payloadType === "task_complete") {
      tryAdvance("complete");
      continue;
    }

    // Stage 4 (writing) advancement: `event_msg/agent_message
    // phase=final_answer` is the authoritative signal. Phase tag
    // distinguishes the final reply from earlier commentary that
    // fires on every turn. `response_item/message` role=assistant
    // entries are intentionally NOT a stage signal - Codex 0.124+
    // emits multiple commentary messages per tool-heavy turn ("I'll
    // look at X first", "Now let me cross-check Y") and a naive
    // count>=2 gate fires on the 2nd commentary at ~27% of turn
    // duration and pins stage 4 for the rest.
    if (entry.type === "event_msg" && payloadType === "agent_message") {
      const phase = getPayloadField<string>(entry, "phase") ?? null;
      if (phase === "final_answer") tryAdvance("writing");
      continue;
    }

    if (entry.type === "response_item" && payloadType === "function_call") {
      toolCallCount++;
      tryAdvance("working");
      // New tool call means we're back in active tool use, not
      // wrapping up - reset the post-tool reasoning counter.
      reasoningSinceLastTool = 0;
      const name = getPayloadField<string>(entry, "name") ?? "";
      const callId = getPayloadField<string>(entry, "call_id") ?? "";
      const argsRaw = getPayloadField<unknown>(entry, "arguments");
      const tool: ToolCall = {
        name,
        callId,
        timestamp,
        argumentsPreview: argumentsPreview(argsRaw),
        completed: false,
      };
      if (callId) pendingByCallId.set(callId, tool);
      activeTool = tool;

      if (name === "update_plan") {
        const parsedPlan = parsePlanArguments(argsRaw);
        if (parsedPlan !== null) plan = parsedPlan;
      }
      continue;
    }

    // Web search emits `response_item/web_search_call`, NOT
    // `function_call`. Self-contained shape - the entry carries
    // `status: "completed"` inline once the search returns, no
    // separate function_call_output follows. Parse it as its own
    // tool so research-heavy turns get toolCallCount + activeTool
    // populated and the post-tool reasoning heuristic fires.
    if (
      entry.type === "response_item" &&
      payloadType === "web_search_call"
    ) {
      toolCallCount++;
      tryAdvance("working");
      reasoningSinceLastTool = 0;
      const status = getPayloadField<string>(entry, "status") ?? "";
      const callId =
        getPayloadField<string>(entry, "id") ?? `ws_${toolCallCount}`;
      const argsRaw = getPayloadField<unknown>(entry, "action");
      const tool: ToolCall = {
        name: "web_search_call",
        callId,
        timestamp,
        argumentsPreview: argumentsPreview(argsRaw),
        completed: status === "completed",
      };
      if (status === "completed") {
        // Self-contained completion: bump the tool-done counter so
        // stage 4 heuristic fires when reasoning follows. Don't
        // set activeTool (nothing pending).
        functionCallOutputsSeen++;
      } else {
        pendingByCallId.set(callId, tool);
        activeTool = tool;
      }
      continue;
    }

    if (
      entry.type === "response_item" &&
      payloadType === "function_call_output"
    ) {
      functionCallOutputsSeen++;
      const callId = getPayloadField<string>(entry, "call_id") ?? "";
      if (callId) {
        const pending = pendingByCallId.get(callId);
        if (pending) {
          pending.completed = true;
          pendingByCallId.delete(callId);
          if (activeTool?.callId === callId) activeTool = null;
        }
      }
      continue;
    }

    if (entry.type === "response_item" && payloadType === "reasoning") {
      // Reasoning alone does NOT advance to stage 3 anymore. Early
      // reasoning belongs to stage 2 (the "reading" window - 7-23s
      // on real research turns). Stage 3 is reserved for active
      // tool use. Pure-reasoning turns with no tools fall back to
      // the walker which timestep-advances through 1-5. Post-tool
      // reasoning still promotes to stage 4 (Finalizing) - the
      // wrap-up window often accounts for 50%+ of synthesis turns.
      if (functionCallOutputsSeen > 0) {
        reasoningSinceLastTool++;
        if (reasoningSinceLastTool >= POST_TOOL_REASONING_THRESHOLD) {
          tryAdvance("writing");
        }
      }
      continue;
    }

    if (entry.type === "event_msg" && payloadType === "token_count") {
      const info = getPayloadField<Record<string, unknown>>(entry, "info");
      const last = info?.last_token_usage as
        | Record<string, unknown>
        | undefined;
      if (last) {
        reasoningTokens =
          typeof last.reasoning_output_tokens === "number"
            ? last.reasoning_output_tokens
            : reasoningTokens;
        outputTokens =
          typeof last.output_tokens === "number"
            ? last.output_tokens
            : outputTokens;
        cachedInputTokens =
          typeof last.cached_input_tokens === "number"
            ? last.cached_input_tokens
            : cachedInputTokens;
        inputTokens =
          typeof last.input_tokens === "number"
            ? last.input_tokens
            : inputTokens;
      }
    }
  }

  const elapsedMs =
    taskStartedAt !== null ? Math.max(0, Date.now() - taskStartedAt) : 0;

  return {
    stage,
    plan,
    activeTool,
    toolCallCount,
    reasoningTokens,
    outputTokens,
    cachedInputTokens,
    inputTokens,
    elapsedMs,
  };
}
